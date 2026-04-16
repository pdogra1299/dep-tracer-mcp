import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../db/database.js';
import { logger } from '../utils/logger.js';

export interface FileChange {
  path: string;       // relative to codebase root
  mtimeMs: number;
  status: 'new' | 'modified' | 'deleted';
}

/**
 * Detect which files have changed since the last index.
 */
export function detectChanges(
  codebaseRoot: string,
  codebaseId: number,
  allFiles: string[],
  db: Database,
  forceFull: boolean,
): FileChange[] {
  if (forceFull) {
    return allFiles.map(path => {
      const fullPath = join(codebaseRoot, path);
      const mtimeMs = existsSync(fullPath) ? statSync(fullPath).mtimeMs : 0;
      return { path, mtimeMs, status: 'new' as const };
    });
  }

  const indexedFiles = db.getFilesByCodebase(codebaseId);
  const indexedMap = new Map(indexedFiles.map(f => [f.path, f.mtime_ms]));
  const currentFileSet = new Set(allFiles);
  const changes: FileChange[] = [];

  // Check for new/modified files
  for (const path of allFiles) {
    const fullPath = join(codebaseRoot, path);
    if (!existsSync(fullPath)) continue;

    const mtimeMs = statSync(fullPath).mtimeMs;
    const indexedMtime = indexedMap.get(path);

    if (indexedMtime === undefined) {
      changes.push({ path, mtimeMs, status: 'new' });
    } else if (mtimeMs > indexedMtime) {
      changes.push({ path, mtimeMs, status: 'modified' });
    }
  }

  // Check for deleted files
  for (const [path] of indexedMap) {
    if (!currentFileSet.has(path)) {
      changes.push({ path, mtimeMs: 0, status: 'deleted' });
    }
  }

  logger.info(`Incremental scan: ${changes.filter(c => c.status === 'new').length} new, ${changes.filter(c => c.status === 'modified').length} modified, ${changes.filter(c => c.status === 'deleted').length} deleted`);
  return changes;
}
