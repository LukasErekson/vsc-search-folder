'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Cache of folder names → full paths, populated as we walk the tree.
 * Cleared when the user runs the command (stale entries are fine because we
 * re-scan the tree each time).
 */
let folderCache: FolderEntry[] | null = null;

interface FolderEntry {
  /** Basename of the folder (e.g. "src"). */
  name: string;
  /** Absolute filesystem path. */
  fullPath: string;
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
// Command handler
// ---------------------------------------------------------------------------

async function goToFolderHandler(uri?: vscode.Uri): Promise<void> {
  // Determine the root folder to search under.
  let rootUri: vscode.Uri;

  if (uri) {
    // Invoked from the explorer context menu on a folder – search under that
    // folder.
    rootUri = uri;
  } else {
    // Invoked from the command palette – use the first workspace folder.
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Search Folder: No workspace folder is open.');
      return;
    }
    rootUri = folders[0].uri;
  }

  // Ask the user what to search for.
  const query = await vscode.window.showInputBox({
    placeHolder: 'Type a folder name to search…',
    prompt: `Searching under: ${vscode.workspace.asRelativePath(rootUri, false) || rootUri.fsPath}`,
    ignoreFocusOut: true,
  });

  if (!query || query.trim().length === 0) {
    return; // user cancelled
  }

  const normalizedQuery = query.trim();

  // Walk the tree with progress.
  const matched = await vscode.window.withProgress<ScoredEntry[]>(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Searching folders matching "${normalizedQuery}"…`,
      cancellable: true,
    },
    async (progress, token) => {
      const entries = await walkTree(rootUri.fsPath, token);
      if (token.isCancellationRequested) {
        return [];
      }
      const scored = scoreEntries(normalizedQuery, entries);
      return scored;
    },
  );

  if (!matched || matched.length === 0) {
    vscode.window.showInformationMessage(`No folders matched "${normalizedQuery}".`);
    return;
  }

  // Show the quick-pick list.
  const picks: vscode.QuickPickItem[] = matched.map((entry) => ({
    label: entry.displayPath,
    description: '', // we show the full path in the detail/label
    detail: entry.fullPath,
  }));

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: `Select a folder (${matched.length} matched)`,
    matchOnDescription: false,
    matchOnDetail: false,
    ignoreFocusOut: true,
  });

  if (!selected) {
    return; // user cancelled
  }

  // Reveal the selected folder in the Explorer sidebar.
  const targetUri = vscode.Uri.file(selected.detail!);
  await vscode.commands.executeCommand('revealInExplorer', targetUri);
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
 *  1. Characters of `query` must appear **in order** in the folder name.
 *  2. Matches are scored higher when they are:
 *      - consecutive
 *      - at word boundaries (camelCase, kebab-case, snake_case)
 *      - at the beginning of the folder name
 *      - in shorter folder names (closer to query length)
 *
 * Returns entries sorted by score descending, capped at `maxResults`.
 */
function scoreEntries(query: string, entries: FolderEntry[]): ScoredEntry[] {
  const lowerQuery = query.toLowerCase();
  const workspaceRoot = vscode.workspace.rootPath || '';
  const threshold: number =
    vscode.workspace.getConfiguration('searchFolder').get('fuzzyThreshold', 0.4);
  const maxResults: number =
    vscode.workspace.getConfiguration('searchFolder').get('maxResults', 50);

  const scored: ScoredEntry[] = [];

  for (const entry of entries) {
    const score = fuzzyScore(lowerQuery, entry.name.toLowerCase(), entry.name, threshold);
    if (score > 0) {
      scored.push({
        displayPath: path.relative(workspaceRoot, entry.fullPath) || entry.fullPath,
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
 *  - +10 per match at the very start of the name
 *  - +5  per match after a path separator (/ or \)
 *  - Length bonus: up to +10 bonus when name length ≈ query length
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
