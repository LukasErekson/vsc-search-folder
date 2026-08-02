'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { scoreEntries, type ScoreConfig } from './scoring';
import { walkTree, DEFAULT_EXCLUDE_PATTERNS, type FolderEntry } from './tree';

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

  // Read user configuration once per invocation.
  const config = vscode.workspace.getConfiguration('searchFolder');
  const excludePatterns: string[] =
    config.get<string[]>('excludePatterns', DEFAULT_EXCLUDE_PATTERNS);
  const scoreConfig: ScoreConfig = {
    threshold: config.get<number>('fuzzyThreshold', 0.4),
    maxResults: config.get<number>('maxResults', 50),
  };

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
      return walkTree(rootFsPath, token, excludePatterns);
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
        updateResults(picker, picker.value, allEntries, rootFsPath, scoreConfig);
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
      updateResults(picker, value, allEntries!, rootFsPath, scoreConfig);
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
  config: ScoreConfig,
): void {
  const scored = scoreEntries(query, entries, displayRoot, config);

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
