import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FolderEntry {
  /** Basename of the folder (e.g. "src"). */
  name: string;
  /** Absolute filesystem path. */
  fullPath: string;
}

/**
 * Minimal stand-in for `vscode.CancellationToken` so this module can be unit
 * tested without loading the `vscode` package.
 */
export interface WalkToken {
  isCancellationRequested: boolean;
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

/**
 * Default folder names skipped during the walk (matched against each folder's
 * basename). Users can override via `searchFolder.excludePatterns`.
 */
export const DEFAULT_EXCLUDE_PATTERNS: string[] = [
  'node_modules',
  '.git',
  '.svn',
  '__pycache__',
  '.next',
  'dist',
  'build',
  'target',
  'vendor',
  '.tox',
  '.venv',
  'env',
  '.env',
];

/**
 * Yield to the event loop after this many directories, so the QuickPick keeps
 * processing keystrokes and cancellations even on very large trees.
 */
const WALK_YIELD_EVERY = 50;

/**
 * Recursively walk the directory tree under `root`, returning every folder as
 * a flat list.
 *
 * Uses async directory reads so the extension host stays responsive on large
 * trees, and skips symbolic links entirely so a symlink cycle cannot hang the
 * walk. Folders whose basename matches `excludePatterns` are skipped along
 * with their whole subtree.
 */
export async function walkTree(
  root: string,
  token: WalkToken,
  excludePatterns: string[] = DEFAULT_EXCLUDE_PATTERNS,
): Promise<FolderEntry[]> {
  const entries: FolderEntry[] = [];
  const pending: string[] = [root];
  let visited = 0;

  while (pending.length > 0) {
    if (token.isCancellationRequested) {
      return entries;
    }

    const dir = pending.pop()!;

    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied, ENOENT, etc. – skip silently.
      continue;
    }

    for (const child of children) {
      // `withFileTypes` dirents don't follow symlinks, so a symlink pointing
      // at an ancestor can't loop; skipping them keeps the walk terminating.
      if (child.isSymbolicLink()) {
        continue;
      }
      if (child.isDirectory()) {
        // Skip excluded folders entirely (exact basename match – not full
        // glob, but fast and catches 99 % of cases), pruning the subtree.
        if (excludePatterns.some((p) => child.name === p)) {
          continue;
        }
        const full = path.join(dir, child.name);
        entries.push({ name: child.name, fullPath: full });
        pending.push(full);
      }
    }

    visited++;
    if (visited % WALK_YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return entries;
}
