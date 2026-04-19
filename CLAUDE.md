# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Two-component system: a VS Code extension (with an embedded WebSocket server) and a Chrome extension. On file save in VS Code, code is broadcast over WebSocket to the Chrome extension, which executes it in the active browser tab.

```
VS Code Extension (runs WS server on port 8765) → Chrome Extension → active tab
```

## VS Code Extension

**Location:** `vscode-extension/`  
**Language:** TypeScript → compiled to `out/extension.js`

```bash
cd vscode-extension
npm install
npm run compile     # one-shot build
npm run watch       # incremental watch
npm run package     # produces .vsix
```

Install in VS Code: **Extensions → Install from VSIX**, or press **F5** to launch in Extension Development Host.

## Chrome Extension

No build step — plain JS/HTML loaded directly as an unpacked extension.

1. `chrome://extensions` → Enable **Developer mode**
2. **Load unpacked** → select `chrome-extension/`

To reload after changes: click the refresh icon on the extension card (or use Extensions Reloader).

## Architecture: Chrome Extension

### Execution worlds

The manifest registers content scripts in two worlds:

| World | Files | Has `chrome.*` APIs |
|---|---|---|
| Extension world | `content.js` | Yes |
| MAIN world (page context) | `classifier.js`, `eval-interceptor.js`, `script-interceptor.js` | No |

### Config bridge pattern

MAIN-world scripts cannot read `chrome.storage`. `content.js` bridges settings by writing to `document.documentElement.dataset`:

- `data-li-eval-enabled` — controls `eval-interceptor.js`
- `data-li-script-enabled` — controls `script-interceptor.js`
- `data-li-break-tags` — JSON array of breakpointed tag names

Both interceptors use a `MutationObserver` on `document.documentElement` to react to changes from the popup without a page reload.

### Message flow for tag classification

```
eval/script interceptors (MAIN) → window.postMessage → content.js → chrome.runtime.sendMessage → panel.js
```

`classifier.js` exposes `window.__liClassifyAndNotify(code, fallback, n)` which both interceptors call. It fires a `window.postMessage` for recognised tags (`Campaign-*`, `Custom-Rule-*`). `content.js` listens and forwards to `chrome.runtime`, where `panel.js` receives it via `chrome.runtime.onMessage`.

### DevTools panel (Interceptor tab)

`devtools.js` → registers `panel.html` as the DevTools panel.  
`panel.html` + `panel.js` — all panel UI and logic in two files; no bundler.

**Theme toggle:** A small inline `<script>` at the bottom of `panel.html` (before `panel.js` loads) reads `li-theme` from `localStorage` and sets `document.documentElement.dataset.theme`. The CSS has three layers: `:root` defaults (dark), `@media (prefers-color-scheme: light) html:not([data-theme="dark"])` (system light), and explicit `[data-theme="light"]` / `[data-theme="dark"]` overrides.

**Break-set storage:** Stored in `chrome.storage.local` as `{ liBreakTags: { [origin]: string[] } }`. The panel reads/writes it; `content.js` mirrors it to `data-li-break-tags` so MAIN-world interceptors can inject `debugger;` statements.

### Key `chrome.storage.local` keys

| Key | Owner | Purpose |
|---|---|---|
| `serverPort` | popup | WebSocket port (default 8765) |
| `preamble` | popup | JS prepended to every injected file |
| `clearEvents` | popup | Whether to call `Insider.eventManager.clearAll()` before injection |
| `evalInterceptorEnabled` | panel chips | Toggle for eval interceptor |
| `scriptInterceptorEnabled` | panel chips | Toggle for script-tag interceptor |
| `liBreakTags` | panel | Per-origin breakpointed tag sets |

## Architecture: VS Code Extension

Single class `LiveCodeInjector` in `src/extension.ts`. Runs an embedded `ws` WebSocket server. On `onDidSaveTextDocument`, sends the file to all connected Chrome clients — but only if a save happens within 5 s of user activity (filters out VS Code auto-saves).

The `liveCodeInjector.executeCurrentFile` command forces immediate execution without waiting for a save event.
