# Live Code Injector

Save a file in VS Code, see it run in the browser a split-second later. No bundler, no reload, no copy-paste.

Built for iterating on Insider campaign code (Custom Rules, Campaign scripts) with full visibility into what's being evaluated and when.

```
VS Code Extension  ──(ws://localhost:8765)──▶  Chrome Extension  ──▶  active tab
 (embeds WS server)                             (runs code in page)
```

## Setup

### VS Code extension

```bash
cd vscode-extension
npm install
npm run compile
```

Install in VS Code: **Extensions → Install from VSIX**, or press **F5** for the Extension Development Host. The embedded WebSocket server starts automatically on port **8765**.

### Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `chrome-extension/`

Connects automatically to `ws://localhost:8765`.

## Usage

1. Open the Chrome popup — status reads **Connected to VS Code**.
2. Save any `.js` or `.css` file in VS Code.
3. It runs in the active tab immediately.

The VS Code command **Live Code Injector: Execute Current File** forces injection without waiting for a save (useful when you want to replay a file).

## The Interceptor DevTools panel

Open DevTools → **Interceptor** tab. This is where most of the power is.

### Tag classification

Every script the page evaluates is intercepted (via `eval()` hook and `<script>` tag observer, both running in the page's MAIN world) and classified:

- `Campaign-<id>` — matched Insider campaign scripts
- `Custom-Rule-<id>` — matched Custom Rule scripts
- Anonymous eval bodies are still surfaced with a synthetic tag

Tags are grouped by **BuilderID** with the `variationId` shown inline. Each row tracks hit count and renders a sparkline of recent activity.

### Breakpoints

Click the break badge on any tag row (or press **Space** with a row focused) to inject a `debugger;` statement the next time that tag evaluates. Break sets persist per origin in `chrome.storage.local`, survive reloads, and are scoped so the same tag breaks the next time you come back to the page.

Bulk-break toggles break state for every rule in a group at once.

### Outcome icons

Custom-Rule rows show a `✓` / `✗` icon indicating whether the rule's evaluation returned truthy (matched) or falsy (skipped) — no more guessing which rules actually fired.

### Live variation indicator

When you're previewing a variation inside Insider's inspector, the matching group in the panel glows teal and shows a `● LIVE` pill next to the `variationId`. Polls every 1.5 s, so switching variations in the inspector updates the panel in real time.

### Filtering and search

- **⌘F** — jump to the filter input
- `all` / `breaking` / `hot` segmented buttons
- Type any substring of a tag, builderId, or variationId

### Interceptor toggles

Toolbar chips turn the eval interceptor and `<script>`-tag interceptor on and off independently. Settings bridge from the popup via `document.documentElement.dataset` into the MAIN-world interceptors with no page reload required.

### Source navigation

Click any tag row to jump straight to its evaluation site in the DevTools **Sources** tab.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘F` | Focus filter input |
| `↑` / `↓` | Move between rows |
| `Space` | Toggle breakpoint on focused row |
| `⌘K` | Clear all breakpoints |
| `Enter` | Open row source in Sources tab |

### Theme

Dark by default, light-mode-aware via `prefers-color-scheme`, and an explicit toggle in the titlebar. Preference persists in `localStorage`.

## Configuration

### VS Code settings

| Setting | Default | Description |
|---|---|---|
| `liveCodeInjector.serverPort` | `8765` | WebSocket port |
| `liveCodeInjector.autoStartServer` | `true` | Start server on VS Code launch |
| `liveCodeInjector.supportedExtensions` | `[".js",".css"]` | File types to watch |
| `liveCodeInjector.enabled` | `true` | Master toggle |

Auto-saves from VS Code are filtered out — a save only triggers injection if it happens within 5 s of user activity in the editor.

### Chrome popup

- **Port** — must match the VS Code `serverPort` setting.
- **JS Variables (Preamble)** — code prepended to every injected JS file (for defining constants, `Insider` shims, etc.).
- **Clear events on inject** — calls `Insider.eventManager.clearAll()` before each injection so campaign-level event listeners don't stack.

## Architecture

### Chrome extension

Two execution worlds:

| World | Files | `chrome.*` APIs |
|---|---|---|
| Extension world | `content.js`, `background.js`, `panel.js`, `popup.js` | Yes |
| Page MAIN world | `classifier.js`, `eval-interceptor.js`, `script-interceptor.js` | No |

MAIN-world scripts can't read `chrome.storage`, so `content.js` bridges settings by writing them onto `document.documentElement.dataset` (`data-li-eval-enabled`, `data-li-script-enabled`, `data-li-break-tags`). Each interceptor attaches a `MutationObserver` to `documentElement` to react to changes instantly, no page reload required.

Tag classification flows:

```
eval/script interceptors (MAIN) → window.postMessage
      → content.js → chrome.runtime.sendMessage
      → panel.js (DevTools panel)
```

### VS Code extension

Single `LiveCodeInjector` class running an embedded `ws` WebSocket server. Listens for `onDidSaveTextDocument` and broadcasts the file contents to every connected Chrome client.

## Files of interest

| Path | Purpose |
|---|---|
| `chrome-extension/classifier.js` | Shared tag classifier, matches `Campaign-*` / `Custom-Rule-*` |
| `chrome-extension/eval-interceptor.js` | Patches `window.eval` / `window.Function` |
| `chrome-extension/script-interceptor.js` | Observes inserted `<script>` tags |
| `chrome-extension/content.js` | Settings bridge + postMessage relay |
| `chrome-extension/panel.html` + `panel.js` | DevTools Interceptor panel |
| `vscode-extension/src/extension.ts` | Embedded WS server + save-broadcast logic |
