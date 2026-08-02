# Search Folder

A VS Code extension that lets you **search for a folder** and **reveal it in the Explorer sidebar** — just like `Go to File…` (`Ctrl+P` / `Cmd+P`) but for folders.

## Features

- **Fuzzy matching** — Type `abc` and find `someAppBaseConfig` with scored relevance sorting
- **Reveal in Explorer** — Select a folder and it's highlighted in the file tree
- **Right-click from Explorer** — Search under any specific folder via context menu
- **Configurable exclusions** — Skip `node_modules`, `.git`, etc.
- **No telemetry, no network** — Pure file-system reads, zero external calls

## Usage

### Command Palette

1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS)
2. Type **Search Folder: Go to Folder…**
3. Start typing a folder name
4. Pick from the scored results
5. The folder is highlighted in the Explorer sidebar

### Explorer Context Menu

Right-click any folder in the Explorer → **Search Folder: Go to Folder…** to search only under that folder.

## Settings

| Setting | Default | Description |
|---|---|---|
| `searchFolder.excludePatterns` | `["node_modules", ".git", …]` | Folder names to exclude from results |
| `searchFolder.maxResults` | `50` | Max results shown in the pick list |
| `searchFolder.fuzzyThreshold` | `0.4` | Sensitivity (0 = exact only, 1 = everything) |

## How It Works

The extension walks your workspace directory tree and scores each folder name using a fuzzy algorithm:

- Characters in your query must appear **in order** in the folder name
- **Consecutive matches** score higher
- Matches at **word boundaries** (camelCase, kebab-case, snake_case) score higher
- **Shorter** folder names get a small bonus
- Results are sorted by score, best first

## Building

```bash
npm install
npm run compile    # TypeScript → out/
npm run lint       # ESLint
npm test           # unit tests (node:test)
npm run package    # produces search-folder-1.0.0.vsix
```

## License

MIT
