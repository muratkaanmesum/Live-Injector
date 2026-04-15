# Live Code Injector — v2

Two components instead of three. The standalone WebSocket server is gone — it's now embedded directly inside the VS Code extension.

```
v1 (original):  VS Code Extension  →  WebSocket Server (separate process)  →  Chrome Extension
v2 (this):      VS Code Extension (runs WS server internally)              →  Chrome Extension
```

## Setup

### 1. VS Code Extension

```bash
cd v2/vscode-extension
npm install
npm run compile
```

Then in VS Code: **Extensions → Install from VSIX** (or press F5 to launch in Extension Development Host).

The extension starts its embedded WebSocket server automatically on port **8765**.

### 2. Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `v2/chrome-extension/`

The extension connects automatically to `ws://localhost:8765`.

## Usage

1. Open the Chrome extension popup — status should show **Connected to VS Code**
2. Save any `.js` or `.css` file in VS Code
3. Code executes instantly in the active browser tab

## Configuration

**VS Code settings:**

| Setting | Default | Description |
|---|---|---|
| `liveCodeInjector.serverPort` | `8765` | WebSocket port |
| `liveCodeInjector.autoStartServer` | `true` | Start server on VS Code launch |
| `liveCodeInjector.supportedExtensions` | `[".js",".css"]` | File types to watch |
| `liveCodeInjector.enabled` | `true` | Enable/disable injection |

**Chrome extension popup:**
- **Port** — must match VS Code setting
- **JS Variables (Preamble)** — code prepended to every injected JS file

## Port conflict with v1?

v2 uses port **8765** by default; v1 uses **8080**. Both can run simultaneously without conflict.
