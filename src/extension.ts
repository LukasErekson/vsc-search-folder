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
  /** Display path relative to workspace root (for the quick-pick label). */
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
      const entries = await walkTree(rootFsPath, token);
      return entries;
    },
  );

  // When the tree walk finishes, store results and un-busy the picker.
  walkPromise.then(
    (entries) => {
      if (walkCancelled) {
        picker.items = [{ label: '(walk cancelled)', kind: vscode.QuickPickItemKind.Separator }];
        return;
      }
      allEntries = entries;
      picker.busy = false;

      // If the user already typed something, apply it now.
      if (picker.value.trim().length > 0) {
        updateResults(picker, picker.value, allEntries);
      }
    },
    (err) => {
      // Walk threw an unexpected error.
      picker.busy = false;
      picker.items = [
        { label: `Error: ${err.message}`, kind: vscode.QuickPickItemKind.Separator },
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
      updateResults(picker, value, allEntries!);
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
): void {
  const scored = scoreEntries(query, entries);

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
 * Recursively walk the directory tree under `root`, returning every folder
 * as a flat list. Skips excluded patterns.
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

  while (pending.length > 0) {
    if (token.isCancellationRequested) {
      return entries;
    }

    const dir = pending.pop()!;

    // Skip if the basename matches an exclusion pattern (simple basename
    // match – not full glob, but fast and catches 99 % of cases).
    const base = path.basename(dir);
    if (dir !== root && excludePatterns.some((p) => base === p)) {
      continue;
    }

    let children: string[];
    try {
      children = fs.readdirSync(dir);
    } catch {
      // Permission denied, ENOENT, etc. – skip silently.
      continue;
    }

    for (const child of children) {
      const full = path.join(dir, child);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        entries.push({ name: child, fullPath: full });
        pending.push(full);
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

interface ScoredEntry {
  /** Display path relative to workspace root (for the quick-pick label). */
  displayPath: string;
  /** Full absolute filesystem path. */
  fullPath: string;
  /** Fuzzy score (higher = better match). */
  score: number;
}

/**
 * Score every entry against `query` using a fuzzy algorithm that mirrors
 * VS Code's Quick Open behaviour:
 *
 *  1. Characters of `query` must appear **in order** in the folder path
 *     (relative to the workspace root), so nested directories can be matched,
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
function scoreEntries(query: string, entries: FolderEntry[]): ScoredEntry[] {
  // Normalise separators so "Models/Nomination" and "Models\Nomination"
  // behave identically on every platform.
  const lowerQuery = query.toLowerCase().replace(/\\/g, '/');
  const workspaceRoot = vscode.workspace.rootPath || '';
  const threshold: number =
    vscode.workspace.getConfiguration('searchFolder').get('fuzzyThreshold', 0.4);
  const maxResults: number =
    vscode.workspace.getConfiguration('searchFolder').get('maxResults', 50);

  const scored: ScoredEntry[] = [];

  for (const entry of entries) {
    // Match against the full path relative to the workspace root (with '/'
    // separators) instead of just the basename, so queries like
    // "Models/Nomination" can match "Library/Models/Nomination".
    const relativePath = path.relative(workspaceRoot, entry.fullPath) || entry.fullPath;
    const normalizedPath = relativePath.replace(/\\/g, '/');
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
    let baseScore = lowerQuery.length * 20;
    // Bonus if it starts at a word boundary.
    if (exactIdx === 0) {
      baseScore += 30; // starts at beginning of name
    } else {
      const prev = originalName[exactIdx - 1];
      if (isWordBoundary(prev)) {
        baseScore += 15;
      }
    }
    // Penalty proportional to how much longer the name is than the query
    // (shorter names get a bonus).
    const lengthRatio = lowerName.length / Math.max(lowerQuery.length, 1);
    if (lengthRatio < 2) {
      baseScore += Math.round((1 - lengthRatio / 2) * 20);
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
      score += consecutive * 20;

      // Word-boundary bonus.
      if (ni === 0) {
        score += 10; // start of name
      } else if (isWordBoundary(originalName[ni - 1])) {
        score += 15;
      }

      // Path-separator bonus.
      if (ni > 0 && (originalName[ni - 1] === '/' || originalName[ni - 1] === '\\')) {
        score += 10;
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
  score -= unusedChars * 2;

  // Length bonus (prefer names closer to query length).
  const lengthRatio = lowerName.length / Math.max(lowerQuery.length, 1);
  if (lengthRatio < 2.5) {
    score += Math.round((1 - lengthRatio / 2.5) * 15);
  }

  // Normalise so scores are comparable across different query lengths.
  const normalised = score / Math.max(lowerQuery.length, 1);

  // Apply the user-configurable threshold.
  if (normalised < threshold * 50) {
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
