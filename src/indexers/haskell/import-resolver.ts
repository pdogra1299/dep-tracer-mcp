import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { logger } from '../../utils/logger.js';

/**
 * Maps Haskell module names to file paths by scanning source directories
 * from package.yaml or .cabal files.
 */
export class HaskellImportResolver {
  private moduleFileMap: Map<string, string> = new Map();
  private sourceDirs: string[] = [];

  constructor(private codebaseRoot: string) {}

  async initialize(): Promise<void> {
    this.sourceDirs = this.findSourceDirs();
    this.buildModuleMap();
    logger.info(`Haskell resolver: ${this.moduleFileMap.size} modules across ${this.sourceDirs.length} source dirs`);
  }

  private findSourceDirs(): string[] {
    const dirs: string[] = [];

    // Try package.yaml (hpack format)
    const pkgYamlPath = join(this.codebaseRoot, 'package.yaml');
    if (existsSync(pkgYamlPath)) {
      const content = readFileSync(pkgYamlPath, 'utf8');
      // Extract source-dirs from YAML (simple regex, handles common cases)
      const srcDirMatch = content.match(/source-dirs:\s*\n((?:\s+-\s+.+\n?)+)/);
      if (srcDirMatch) {
        const lines = srcDirMatch[1].split('\n');
        for (const line of lines) {
          const m = line.match(/^\s+-\s+(.+)/);
          if (m) dirs.push(m[1].trim());
        }
      }
      // Also check single source-dir
      const singleMatch = content.match(/source-dirs:\s+(\S+)/);
      if (singleMatch && dirs.length === 0) {
        dirs.push(singleMatch[1]);
      }
    }

    // Fallback: scan for common Haskell source directories
    if (dirs.length === 0) {
      for (const candidate of ['src', 'src-generated', 'lib', 'app', 'test']) {
        const full = join(this.codebaseRoot, candidate);
        if (existsSync(full) && statSync(full).isDirectory()) {
          dirs.push(candidate);
        }
      }
    }

    return dirs;
  }

  private buildModuleMap(): void {
    for (const dir of this.sourceDirs) {
      const fullDir = join(this.codebaseRoot, dir);
      if (!existsSync(fullDir)) continue;
      this.walkDir(fullDir, dir, []);
    }
  }

  private walkDir(absDir: string, relBase: string, modulePrefix: string[]): void {
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
          if (entry === 'node_modules' || entry === '.git' || entry === 'dist-newstyle') continue;
          this.walkDir(absPath, relPath, [...modulePrefix, entry]);
        } else if (entry.endsWith('.hs') && !entry.startsWith('.')) {
          const moduleName = [...modulePrefix, basename(entry, '.hs')].join('.');
          this.moduleFileMap.set(moduleName, relPath);
        }
      } catch {
        // skip inaccessible
      }
    }
  }

  resolveModuleName(moduleName: string): string | null {
    return this.moduleFileMap.get(moduleName) ?? null;
  }

  getAllHsFiles(): string[] {
    return Array.from(this.moduleFileMap.values());
  }

  getModuleName(filePath: string): string | null {
    for (const [mod, path] of this.moduleFileMap) {
      if (path === filePath) return mod;
    }
    return null;
  }
}
