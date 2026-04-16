import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { logger } from '../../utils/logger.js';

interface RescriptSource {
  dir: string;
  subdirs?: boolean;
}

interface RescriptConfig {
  name: string;
  sources: Array<string | RescriptSource>;
  namespace?: boolean;
  suffix?: string;
  dependencies?: string[];
}

/**
 * Resolves ReScript module names and @package/* aliases to file paths.
 */
export class ModuleResolver {
  private packageAliasMap: Map<string, string> = new Map();
  private sourceRoots: string[] = [];
  private moduleFileMap: Map<string, string> = new Map(); // moduleName → relative file path

  constructor(
    private codebaseRoot: string,
    private config: RescriptConfig,
  ) {}

  async initialize(): Promise<void> {
    this.buildPackageAliasMap();
    this.collectSourceRoots();
    this.buildModuleFileMap();
    logger.info(`Module resolver: ${this.moduleFileMap.size} modules, ${this.packageAliasMap.size} package aliases`);
  }

  /**
   * Build a map from @package/* names to actual directory paths
   * by scanning workspace packages for their package.json "name" fields.
   */
  private buildPackageAliasMap(): void {
    // Check monorepo workspaces in root package.json
    const rootPkgPath = join(this.codebaseRoot, 'package.json');
    if (!existsSync(rootPkgPath)) return;

    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
    const workspacePatterns: string[] = [];

    if (Array.isArray(rootPkg.workspaces)) {
      workspacePatterns.push(...rootPkg.workspaces);
    } else if (rootPkg.workspaces?.packages) {
      workspacePatterns.push(...rootPkg.workspaces.packages);
    }

    for (const pattern of workspacePatterns) {
      const isGlob = pattern.endsWith('/*') || pattern.endsWith('/**/');

      if (isGlob) {
        // Glob pattern like "packages/*" or "apps/*" — scan all subdirectories
        const base = pattern.replace(/\/?\*\*?\/?$/, '');
        const dir = join(this.codebaseRoot, base);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;

        for (const entry of readdirSync(dir)) {
          this.tryRegisterPackage(join(dir, entry));
        }
      } else {
        // Direct path like "packages/common" — check this directory directly
        const dir = join(this.codebaseRoot, pattern);
        this.tryRegisterPackage(dir);
      }
    }
    logger.debug('Package aliases:', Object.fromEntries(this.packageAliasMap));
  }

  private tryRegisterPackage(dir: string): void {
    const pkgJsonPath = join(dir, 'package.json');
    if (!existsSync(pkgJsonPath)) return;
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      if (pkg.name) {
        const relPath = relative(this.codebaseRoot, dir);
        this.packageAliasMap.set(pkg.name, relPath);
      }
    } catch {
      // skip malformed package.json
    }
  }

  /**
   * Collect all source directories from rescript.json.
   */
  private collectSourceRoots(): void {
    for (const source of this.config.sources) {
      const dir = typeof source === 'string' ? source : source.dir;
      this.sourceRoots.push(dir);
    }
  }

  /**
   * Walk all source directories and map module names (filename without extension) to file paths.
   */
  private buildModuleFileMap(): void {
    for (const root of this.sourceRoots) {
      const fullRoot = join(this.codebaseRoot, root);
      if (!existsSync(fullRoot)) continue;
      this.walkDir(fullRoot, root);
    }

    // Also walk package dependency directories
    for (const [pkgName, pkgPath] of this.packageAliasMap) {
      if (!this.config.dependencies?.includes(pkgName)) continue;
      const fullPath = join(this.codebaseRoot, pkgPath);
      // Look for rescript.json in the package to find its sources
      const pkgRescriptPath = join(fullPath, 'rescript.json');
      if (existsSync(pkgRescriptPath)) {
        try {
          const pkgConfig: RescriptConfig = JSON.parse(readFileSync(pkgRescriptPath, 'utf8'));
          for (const source of pkgConfig.sources) {
            const dir = typeof source === 'string' ? source : source.dir;
            const fullDir = join(fullPath, dir);
            if (existsSync(fullDir)) {
              this.walkDir(fullDir, join(pkgPath, dir));
            }
          }
        } catch {
          // fallback: walk the whole package
          this.walkDir(fullPath, pkgPath);
        }
      }
    }
  }

  private walkDir(absDir: string, relBase: string): void {
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const absPath = join(absDir, entry);
      const relPath = join(relBase, entry);
      try {
        const stat = statSync(absPath);
        if (stat.isDirectory()) {
          // Skip node_modules, lib, build directories
          if (entry === 'node_modules' || entry === 'lib' || entry === 'build' || entry === '.git') continue;
          this.walkDir(absPath, relPath);
        } else if (entry.endsWith('.res')) {
          const moduleName = basename(entry, '.res');
          // In flat namespace mode (namespace: false), module name = filename
          // If there are duplicates, the last one wins (ReScript would error on real duplicates)
          this.moduleFileMap.set(moduleName, relPath);
        }
      } catch {
        // skip inaccessible files
      }
    }
  }

  /**
   * Resolve a .bs.js import path to a .res file path relative to codebase root.
   * Returns null for external/runtime imports.
   */
  resolveImportPath(importPath: string, sourceFile: string): string | null {
    // Skip non-codebase imports
    if (!importPath.endsWith('.bs.js')) return null;
    if (importPath.includes('@rescript/runtime')) return null;
    if (importPath.includes('@rescript/react')) return null;

    // Handle @package/* aliases
    for (const [alias, localPath] of this.packageAliasMap) {
      if (importPath.startsWith(alias + '/')) {
        const rest = importPath.slice(alias.length + 1);
        return join(localPath, rest).replace(/\.bs\.js$/, '.res');
      }
    }

    // Handle relative paths — join against the source file's directory,
    // then normalize to produce a codebase-root-relative path.
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      const sourceDir = dirname(sourceFile);
      // Use join (not resolve) to stay relative, then normalize away ../
      const joined = join(sourceDir, importPath);
      // Normalize: resolve against a fake root to collapse ../ segments, then strip it
      const normalized = resolve('/', joined).slice(1); // e.g., "src/utils/WebViewUtils.bs.js"
      return normalized.replace(/\.bs\.js$/, '.res');
    }

    return null;
  }

  /**
   * Resolve a ReScript module name to its source file path.
   */
  resolveModuleName(moduleName: string): string | null {
    return this.moduleFileMap.get(moduleName) ?? null;
  }

  /**
   * Get all .res files across source directories.
   */
  getAllResFiles(): string[] {
    return Array.from(this.moduleFileMap.values());
  }

  /**
   * Get the module name for a file path.
   */
  getModuleName(filePath: string): string {
    return basename(filePath, '.res');
  }

  static async loadConfig(codebaseRoot: string): Promise<RescriptConfig> {
    const rescriptJsonPath = join(codebaseRoot, 'rescript.json');
    const bsconfigPath = join(codebaseRoot, 'bsconfig.json');

    const configPath = existsSync(rescriptJsonPath) ? rescriptJsonPath : bsconfigPath;
    if (!existsSync(configPath)) {
      throw new Error(`No rescript.json or bsconfig.json found in ${codebaseRoot}`);
    }

    return JSON.parse(readFileSync(configPath, 'utf8'));
  }
}
