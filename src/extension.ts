'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FolderEntry {
  /** Basename of the folder (e.g. "src"). */
  name: string;
  /** Absolute filesystem path. */
  fullPath: string;
}

interface ScoredEntry {
  /** Display path relative to the search root (for the quick-pick label). */
  displayPath: string;
  /** Full absolute filesystem path. */
  fullPath: string;
  /** Fuzzy score (higher = better match). */
  score: number;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('searchFolder.goToFolder', goToFolderHandler),
  );
}

export function deactivate(): void {
  // noop
}

// ---------------------------------------------------------------------------
// Command handler  (live QuickPick version)
// ---------------------------------------------------------------------------

async function goToFolderHandler(uri?: vscode.Uri): Promise<void> {
  // ── 1. Determine root folder ──────────────────────────────────────────
  let rootUri: vscode.Uri;

  if (uri) {
    rootUri = uri;
  } else {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Search Folder: No workspace folder is open.');
      return;
    }
    rootUri = folders[0].uri;
  }

  const rootFsPath = rootUri.fsPath;
  const rootLabel =
    vscode.workspace.asRelativePath(rootUri, false) || rootFsPath;

  // ── 2. Create QuickPick (appears immediately) ────────────────────────
  const picker = vscode.window.createQuickPick();
  picker.placeholder = `Search folders under ${rootLabel}…`;
  picker.ignoreFocusOut = true;
  picker.busy = true; // spinner while tree loads
  picker.show();

  // ── 3. Walk the tree in the background ────────────────────────────────
  let allEntries: FolderEntry[] | null = null;
  let walkCancelled = false;
  let disposed = false; // set once the picker has been hidden/disposed

  const walkPromise = vscode.window.withProgress<FolderEntry[]>(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Walking folder tree under ${rootLabel}…`,
      cancellable: true,
    },
    async (_progress, token) => {
      token.onCancellationRequested(() => {
        walkCancelled = true;
      });
      return walkTree(rootFsPath, token);
    },
  );

  // When the tree walk finishes, store results and un-busy the picker.
  walkPromise.then(
    (entries) => {
      if (disposed) {
        return; // picker already closed – nothing to update
      }
      if (walkCancelled) {
        picker.items = [{ label: '(walk cancelled)', kind: vscode.QuickPickItemKind.Separator }];
        return;
      }
      // Include the search root itself so it can be selected and revealed too
      // (e.g. after right-clicking a folder and searching under it).
      allEntries = [{ name: path.basename(rootFsPath), fullPath: rootFsPath }, ...entries];
      picker.busy = false;

      // If the user already typed something, apply it now.
      if (picker.value.trim().length > 0) {
        updateResults(picker, picker.value, allEntries, rootFsPath);
      }
    },
    (err) => {
      // Walk threw an unexpected error.
      if (disposed) {
        return;
      }
      picker.busy = false;
      const message = err instanceof Error ? err.message : String(err);
      picker.items = [
        { label: `Error: ${message}`, kind: vscode.QuickPickItemKind.Separator },
      ];
    },
  );

  // ── 4. Debounced live filtering on each keystroke ────────────────────
  let debounceTimer: NodeJS.Timeout | undefined;

  picker.onDidChangeValue((value) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }

    if (!allEntries) {
      return; // tree still loading – wait
    }

    if (value.trim().length === 0) {
      picker.items = [];
      return;
    }

    // 120 ms debounce feels snappy.
    debounceTimer = setTimeout(() => {
      updateResults(picker, value, allEntries!, rootFsPath);
    }, 120);
  });

  // ── 5. On selection  →  reveal + expand in Explorer ──────────────────
  picker.onDidAccept(() => {
    const selected = picker.selectedItems[0];
    if (!selected || !selected.detail) {
      return;
    }
    const targetUri = vscode.Uri.file(selected.detail);
    picker.hide();
    void revealAndExpandInExplorer(targetUri);
  });

  // ── 6. Clean-up on dismiss ───────────────────────────────────────────
  picker.onDidHide(() => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    walkCancelled = true;
    disposed = true;
    picker.dispose();
  });
}

// ---------------------------------------------------------------------------
// Build QuickPick items from scratch
// ---------------------------------------------------------------------------

/**
 * Reveals `uri` in the Explorer and expands the folder so its children are
 * visible.
 *
 * `revealInExplorer` only opens the Explorer, reveals + selects the folder
 * (expanding its ancestors) and focuses the tree. The built-in `list.expand`
 * command then expands the focused folder itself, which is the extra step
 * that makes the folder's contents visible.
 */
async function revealAndExpandInExplorer(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('revealInExplorer', uri);
  await vscode.commands.executeCommand('list.expand');
}

function updateResults(
  picker: vscode.QuickPick<vscode.QuickPickItem>,
  query: string,
  entries: FolderEntry[],
  displayRoot: string,
): void {
  const scored = scoreEntries(query, entries, displayRoot);

  if (scored.length === 0) {
    picker.items = [
      {
        label: `No folders matched "${query}"`,
        kind: vscode.QuickPickItemKind.Separator,
      },
    ];
    return;
  }

  picker.items = scored.map((entry) => ({
    label: entry.displayPath,
    description: '',
    detail: entry.fullPath,
  }));
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

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
 * walk. Folders whose basename matches `searchFolder.excludePatterns` are
 * skipped along with their whole subtree.
 */
async function walkTree(root: string, token: vscode.CancellationToken): Promise<FolderEntry[]> {
  const excludePatterns: string[] =
    vscode.workspace.getConfiguration('searchFolder').get('excludePatterns', [
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
    ]);

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

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

// Scoring weights for `fuzzyScore` (higher is better). Tune these together;
// the JSDoc on `fuzzyScore` documents how they combine.
const CONSECUTIVE_BONUS = 20; // per consecutive matched character
const WORD_BOUNDARY_BONUS = 15; // match after _ - . / space
const START_OF_NAME_BONUS = 10; // match at the very start of the path
const EXACT_START_BONUS = 30; // contiguous match starting at position 0
const PATH_SEPARATOR_BONUS = 10; // match right after a / or \
const SHORT_NAME_RATIO = 2; // length bonus kicks in below this ratio (exact branch)
const SHORT_NAME_BONUS = 20; // max length bonus (exact branch)
const FUZZY_SHORT_NAME_RATIO = 2.5; // length bonus kicks in below this ratio (fuzzy branch)
const FUZZY_SHORT_NAME_BONUS = 15; // max length bonus (fuzzy branch)
const UNMATCHED_CHAR_PENALTY = 2; // penalty per unmatched character (fuzzy branch)
const THRESHOLD_SCALE = 50; // maps the 0–1 config threshold onto raw score space

/**
 * Score every entry against `query` using a fuzzy algorithm that mirrors
 * VS Code's Quick Open behaviour:
 *
 *  1. Characters of `query` must appear **in order** in the folder path
 *     (relative to `displayRoot`), so nested directories can be matched,
 *     e.g. `Models/Nomination` matches `Library/Models/Nomination`.
 *  2. `/` and `\` are interchangeable in the query and the matched paths, so
 *     the same query works on Linux and Windows.
 *  3. Matches are scored higher when they are:
 *      - consecutive
 *      - at word boundaries (camelCase, kebab-case, snake_case)
 *      - at the beginning of the folder path
 *      - in shorter folder paths (closer to query length)
 *
 * Returns entries sorted by score descending, capped at `maxResults`.
 */
function scoreEntries(query: string, entries: FolderEntry[], displayRoot: string): ScoredEntry[] {
  // Normalise separators so "Models/Nomination" and "Models\Nomination"
  // behave identically on every platform.
  const lowerQuery = query.toLowerCase().replace(/\\/g, '/');
  const threshold: number =
    vscode.workspace.getConfiguration('searchFolder').get('fuzzyThreshold', 0.4);
  const maxResults: number =
    vscode.workspace.getConfiguration('searchFolder').get('maxResults', 50);

  const scored: ScoredEntry[] = [];

  for (const entry of entries) {
    // Match against the full path relative to the search root (with '/'
    // separators) instead of just the basename, so queries like
    // "Models/Nomination" can match "Library/Models/Nomination". The search
    // root itself is shown by its basename.
    const relativePath = path.relative(displayRoot, entry.fullPath);
    const displayPath = relativePath || path.basename(entry.fullPath);
    const normalizedPath = displayPath.replace(/\\/g, '/');
    const score = fuzzyScore(lowerQuery, normalizedPath.toLowerCase(), normalizedPath, threshold);
    if (score > 0) {
      scored.push({
        displayPath: normalizedPath,
        fullPath: entry.fullPath,
        score,
      });
    }
  }

  // Sort descending by score.
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults);
}

/**
 * Compute a fuzzy match score.
 *
 * @returns A positive score if `query` matches `lowerName`, or -1 if no match.
 *
 * Scoring breakdown (cumulative, higher is better):
 *  - +20 per consecutive matched character
 *  - +15 per word-boundary match (uppercase after lowercase, or after _ / - / . / space)
 *  - +10 per match at the very start of the path
 *  - +10 per match after a path separator (/ or \)
 *  - Length bonus: up to +15 bonus when path length ≈ query length
 */
function fuzzyScore(
  lowerQuery: string,
  lowerName: string,
  originalName: string,
  threshold: number,
): number {
  if (lowerQuery.length === 0) {
    return -1;
  }

  // Fast exact-contains check – if it contains the query as a contiguous
  // substring it's always a match.
  const exactIdx = lowerName.indexOf(lowerQuery);
  if (exactIdx >= 0) {
    // Base score: contiguous match.
    let baseScore = lowerQuery.length * CONSECUTIVE_BONUS;
    // Bonus if it starts at a word boundary.
    if (exactIdx === 0) {
      baseScore += EXACT_START_BONUS; // starts at beginning of name
    } else {
      const prev = originalName[exactIdx - 1];
      if (isWordBoundary(prev)) {
        baseScore += WORD_BOUNDARY_BONUS;
      }
    }
    // Penalty proportional to how much longer the name is than the query
    // (shorter names get a bonus).
    const lengthRatio = lowerName.length / Math.max(lowerQuery.length, 1);
    if (lengthRatio < SHORT_NAME_RATIO) {
      baseScore += Math.round((1 - lengthRatio / SHORT_NAME_RATIO) * SHORT_NAME_BONUS);
    }
    return Math.max(baseScore, 1);
  }

  // ---- Fuzzy (non-contiguous) matching ----
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let totalMatched = 0;

  for (let ni = 0; ni < lowerName.length && qi < lowerQuery.length; ni++) {
    if (lowerName[ni] === lowerQuery[qi]) {
      qi++;
      totalMatched++;
      consecutive++;

      // Consecutive bonus.
      score += consecutive * CONSECUTIVE_BONUS;

      // Word-boundary bonus.
      if (ni === 0) {
        score += START_OF_NAME_BONUS; // start of name
      } else if (isWordBoundary(originalName[ni - 1])) {
        score += WORD_BOUNDARY_BONUS;
      }

      // Path-separator bonus.
      if (ni > 0 && (originalName[ni - 1] === '/' || originalName[ni - 1] === '\\')) {
        score += PATH_SEPARATOR_BONUS;
      }
    } else {
      consecutive = 0;
    }
  }

  // Did we match all characters?
  if (qi < lowerQuery.length) {
    return -1; // not all characters found in order
  }

  // Penalty for unmatched characters in the name (spread penalty).
  const unusedChars = lowerName.length - totalMatched;
  score -= unusedChars * UNMATCHED_CHAR_PENALTY;

  // Length bonus (prefer names closer to query length).
  const lengthRatio = lowerName.length / Math.max(lowerQuery.length, 1);
  if (lengthRatio < FUZZY_SHORT_NAME_RATIO) {
    score += Math.round((1 - lengthRatio / FUZZY_SHORT_NAME_RATIO) * FUZZY_SHORT_NAME_BONUS);
  }

  // Normalise so scores are comparable across different query lengths.
  const normalised = score / Math.max(lowerQuery.length, 1);

  // Apply the user-configurable threshold.
  if (normalised < threshold * THRESHOLD_SCALE) {
    return -1;
  }

  return Math.max(Math.round(normalised), 1);
}

/**
 * Returns true when `ch` is a character that typically separates "words" in
 * file/folder names.
 */
function isWordBoundary(ch: string): boolean {
  return (
    ch === '_' ||
    ch === '-' ||
    ch === '.' ||
    ch === ' ' ||
    ch === '/' ||
    ch === '\\'
  );
}
