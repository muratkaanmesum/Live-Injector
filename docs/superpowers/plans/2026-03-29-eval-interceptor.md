# Eval Interceptor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monkey-patch `window.eval` and `window.Function` in the page's MAIN world so eval'd code appears as named files in DevTools and optionally auto-breaks with `debugger;` when code matches a user-supplied regex.

**Architecture:** A new `eval-interceptor.js` content script runs in `world: "MAIN"` at `document_start` and wraps both globals. Settings are bridged from the isolated world via `document.documentElement.dataset` attributes written by `content.js`. The popup exposes a toggle and a regex input backed by `chrome.storage.local`.

**Tech Stack:** MV3 Chrome extension, vanilla JS, `chrome.storage.local`, `Proxy`/`Reflect` for Function patching.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `chrome-extension/eval-interceptor.js` | Create | MAIN-world patch; wraps eval + Function; reads config from dataset |
| `chrome-extension/manifest.json` | Modify | Register `eval-interceptor.js` as second content script with `"world": "MAIN"` |
| `chrome-extension/content.js` | Modify | Read storage keys, write dataset bridge, keep live via `onChanged` |
| `chrome-extension/popup.html` | Modify | Add Eval Interceptor toggle section + pattern input section |
| `chrome-extension/popup.js` | Modify | Load/save `evalInterceptorEnabled` and `evalInterceptorPattern` |

---

### Task 1: Register eval-interceptor.js in manifest

**Files:**
- Modify: `chrome-extension/manifest.json`

- [ ] **Step 1: Add the MAIN world content script entry**

Open `chrome-extension/manifest.json`. The `content_scripts` array currently has one entry (for `content.js` in the isolated world). Add a second entry after it:

```json
{
  "manifest_version": 3,
  "name": "Live Code Injector v2",
  "version": "2.0.0",
  "description": "Receives and executes code from VS Code for live development (v2 — no standalone server needed)",
  "permissions": [
    "activeTab",
    "scripting",
    "storage"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_start",
      "all_frames": true
    },
    {
      "matches": ["<all_urls>"],
      "js": ["eval-interceptor.js"],
      "run_at": "document_start",
      "all_frames": true,
      "world": "MAIN"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_title": "Live Code Injector v2"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self';"
  }
}
```

- [ ] **Step 2: Verify the extension still loads**

1. Open `chrome://extensions`
2. Click "Reload" on Live Code Injector v2
3. Confirm no errors appear under the extension card
4. Open any tab (e.g. `about:blank`) and open DevTools Console — confirm no extension errors

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/manifest.json
git commit -m "feat: register eval-interceptor.js as MAIN world content script"
```

---

### Task 2: Create eval-interceptor.js

**Files:**
- Create: `chrome-extension/eval-interceptor.js`

- [ ] **Step 1: Verify the patch point manually before writing**

In DevTools Console on any tab, run:
```js
window.eval === eval  // should be true — confirms eval resolves to window.eval
window.Function === Function  // should be true
Function.prototype === (new Function()).constructor.prototype  // should be true — we must preserve this
```

- [ ] **Step 2: Create the file**

Create `chrome-extension/eval-interceptor.js` with this content:

```javascript
// Eval Interceptor — Live Code Injector v2
// Runs in MAIN world at document_start.
// Reads config from document.documentElement.dataset (written by content.js).
(function () {
  'use strict';

  const _eval = window.eval;
  const _Function = window.Function;
  let counter = 0;

  function getConfig() {
    const ds = document.documentElement.dataset;
    return {
      enabled: ds.liEvalEnabled === 'true',
      pattern: ds.liEvalPattern || ''
    };
  }

  function shouldBreak(code, pattern) {
    if (!pattern) return false;
    try { return new RegExp(pattern).test(code); }
    catch (e) { return false; }
  }

  function wrapCode(code, tag) {
    const { enabled, pattern } = getConfig();
    if (!enabled) return code;
    const n = ++counter;
    const sourceURL = '\n//# sourceURL=eval-interceptor://' + tag + '-' + n + '.js';
    const breakLine = shouldBreak(code, pattern) ? 'debugger;\n' : '';
    return breakLine + code + sourceURL;
  }

  // ── eval patch ────────────────────────────────────────────────────
  window.eval = function liEval(code) {
    if (typeof code !== 'string') return _eval.call(this, code);
    return _eval.call(this, wrapCode(code, 'eval'));
  };

  // ── Function patch ────────────────────────────────────────────────
  // Use Proxy to preserve instanceof, .prototype, and .constructor checks.
  window.Function = new Proxy(_Function, {
    construct: function (target, args) {
      if (args.length > 0 && typeof args[args.length - 1] === 'string') {
        args = args.slice();
        args[args.length - 1] = wrapCode(args[args.length - 1], 'Function');
      }
      return Reflect.construct(target, args, target);
    },
    apply: function (target, thisArg, args) {
      if (args.length > 0 && typeof args[args.length - 1] === 'string') {
        args = args.slice();
        args[args.length - 1] = wrapCode(args[args.length - 1], 'Function');
      }
      return Reflect.apply(target, thisArg, args);
    }
  });
})();
```

- [ ] **Step 3: Reload extension and verify patching**

1. Reload extension at `chrome://extensions`
2. Open a new tab, open DevTools Console
3. Run: `window.eval.name` — should return `"liEval"` (confirms our wrapper is active)
4. Run: `new Function('return 1')()` — should return `1` (confirms Function still works)
5. Run: `new Function('return 1') instanceof Function` — should return `true` (confirms Proxy preserves instanceof)

- [ ] **Step 4: Verify sourceURL appears when enabled**

Since the dataset bridge doesn't exist yet, manually set it to test:

In DevTools Console:
```js
document.documentElement.dataset.liEvalEnabled = 'true';
document.documentElement.dataset.liEvalPattern = '';
eval('1 + 1');
```

Open DevTools **Sources** panel → **Page** tree. You should see `eval-interceptor://eval-1.js` listed as a named source instead of `VM###`.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/eval-interceptor.js
git commit -m "feat: add eval-interceptor.js — patches window.eval and window.Function in MAIN world"
```

---

### Task 3: Add config bridge to content.js

**Files:**
- Modify: `chrome-extension/content.js`

- [ ] **Step 1: Add the bridge code**

Open `chrome-extension/content.js`. Add the following block at the **end** of the IIFE, just before the closing `})();`:

```javascript
  // ── Eval interceptor config bridge ───────────────────────────────
  // eval-interceptor.js runs in MAIN world and cannot access chrome.storage.
  // We bridge settings via dataset attributes on <html> so both worlds can read them.

  function applyEvalConfig(enabled, pattern) {
    document.documentElement.dataset.liEvalEnabled = enabled ? 'true' : 'false';
    document.documentElement.dataset.liEvalPattern = pattern || '';
  }

  chrome.storage.local.get(['evalInterceptorEnabled', 'evalInterceptorPattern'], function (result) {
    applyEvalConfig(result.evalInterceptorEnabled || false, result.evalInterceptorPattern || '');
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (!('evalInterceptorEnabled' in changes) && !('evalInterceptorPattern' in changes)) return;
    chrome.storage.local.get(['evalInterceptorEnabled', 'evalInterceptorPattern'], function (result) {
      applyEvalConfig(result.evalInterceptorEnabled || false, result.evalInterceptorPattern || '');
    });
  });
```

After the edit, the end of `content.js` should look like:

```javascript
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'code-executed') {
      showNotification(message.filename, message.codeType);
    }
  });

  // ── Eval interceptor config bridge ───────────────────────────────
  function applyEvalConfig(enabled, pattern) {
    document.documentElement.dataset.liEvalEnabled = enabled ? 'true' : 'false';
    document.documentElement.dataset.liEvalPattern = pattern || '';
  }

  chrome.storage.local.get(['evalInterceptorEnabled', 'evalInterceptorPattern'], function (result) {
    applyEvalConfig(result.evalInterceptorEnabled || false, result.evalInterceptorPattern || '');
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (!('evalInterceptorEnabled' in changes) && !('evalInterceptorPattern' in changes)) return;
    chrome.storage.local.get(['evalInterceptorEnabled', 'evalInterceptorPattern'], function (result) {
      applyEvalConfig(result.evalInterceptorEnabled || false, result.evalInterceptorPattern || '');
    });
  });

})();
```

- [ ] **Step 2: Reload extension and verify bridge**

1. Reload the extension
2. Open a tab, open DevTools Console
3. Run: `document.documentElement.dataset` — you should see `liEvalEnabled: "false"` and `liEvalPattern: ""` in the output (even with no popup interaction yet, defaults are applied)

- [ ] **Step 3: Verify live update**

In DevTools Console, manually set storage to simulate toggling:
```js
chrome.storage.local.set({ evalInterceptorEnabled: true, evalInterceptorPattern: 'hello' });
```
Then immediately run: `document.documentElement.dataset`
You should see `liEvalEnabled: "true"` and `liEvalPattern: "hello"` update.

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/content.js
git commit -m "feat: bridge eval interceptor settings from storage to DOM dataset"
```

---

### Task 4: Add UI to popup.html

**Files:**
- Modify: `chrome-extension/popup.html`

- [ ] **Step 1: Add the CSS for the pattern input**

In `popup.html`, find the `<style>` block. Add these rules at the end of the `<style>` block, just before `</style>`:

```css
      .eval-pattern-section {
        background: white;
        padding: 15px;
        border-radius: 6px;
        margin-bottom: 15px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      }
      .eval-pattern-section h3 { margin: 0 0 6px 0; font-size: 14px; color: #333; }
      .eval-pattern-section p  { margin: 0 0 8px 0; font-size: 11px; color: #888; line-height: 1.4; }
      #eval-pattern {
        width: 100%;
        font-family: monospace;
        font-size: 11px;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 6px;
        box-sizing: border-box;
        color: #333;
      }
      #eval-pattern-error {
        font-size: 11px;
        color: #f44336;
        margin-top: 4px;
        min-height: 16px;
      }
```

- [ ] **Step 2: Add the toggle and pattern sections to the body**

In `popup.html`, find the existing Clear Events toggle section:

```html
<div class="toggle-section">
      <div>
        <div class="toggle-label">Clear Events</div>
        <div class="toggle-sub">Runs <code>Insider.eventManager.clearAll()</code></div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="clear-events-toggle" />
        <span class="toggle-slider"></span>
      </label>
    </div>
```

Add the two new sections **after** it (before the `<div class="preamble-section">`):

```html
    <div class="toggle-section">
      <div>
        <div class="toggle-label">Eval Interceptor</div>
        <div class="toggle-sub">Adds sourceURL + <code>debugger;</code> on match</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="eval-interceptor-toggle" />
        <span class="toggle-slider"></span>
      </label>
    </div>

    <div class="eval-pattern-section">
      <h3>Debugger Pattern</h3>
      <p>Regex — prepends <code>debugger;</code> to matching eval'd code.</p>
      <input type="text" id="eval-pattern" spellcheck="false" placeholder="/myFunction|someModule/i" />
      <div id="eval-pattern-error"></div>
    </div>
```

- [ ] **Step 3: Verify HTML renders correctly**

1. Reload the extension
2. Click the extension icon to open the popup
3. Confirm you see:
   - "Eval Interceptor" toggle (off by default)
   - "Debugger Pattern" input section below it
   - No layout breaks in the existing sections

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/popup.html
git commit -m "feat: add Eval Interceptor toggle and pattern input to popup UI"
```

---

### Task 5: Wire storage in popup.js

**Files:**
- Modify: `chrome-extension/popup.js`

- [ ] **Step 1: Add element references**

In `popup.js`, find the block at the top of the `DOMContentLoaded` listener where element references are declared:

```javascript
  const preambleTA      = document.getElementById('preamble');
  const savePreamble    = document.getElementById('save-preamble');
  const saveStatus      = document.getElementById('save-status');

  const clearEventsToggle = document.getElementById('clear-events-toggle');
```

Add two new references after the existing ones:

```javascript
  const evalInterceptorToggle = document.getElementById('eval-interceptor-toggle');
  const evalPatternInput      = document.getElementById('eval-pattern');
  const evalPatternError      = document.getElementById('eval-pattern-error');
```

- [ ] **Step 2: Load saved values**

Find the existing `chrome.storage.local.get` call that loads `preamble` and `clearEvents`:

```javascript
  chrome.storage.local.get(['preamble', 'clearEvents'], ({ preamble = '', clearEvents = false }) => {
    preambleTA.value          = preamble;
    clearEventsToggle.checked = clearEvents;
  });
```

Replace it with an extended version that also loads the new keys:

```javascript
  chrome.storage.local.get(
    ['preamble', 'clearEvents', 'evalInterceptorEnabled', 'evalInterceptorPattern'],
    ({ preamble = '', clearEvents = false, evalInterceptorEnabled = false, evalInterceptorPattern = '' }) => {
      preambleTA.value              = preamble;
      clearEventsToggle.checked     = clearEvents;
      evalInterceptorToggle.checked = evalInterceptorEnabled;
      evalPatternInput.value        = evalInterceptorPattern;
    }
  );
```

- [ ] **Step 3: Wire the toggle**

Find the Clear Events toggle listener:

```javascript
  clearEventsToggle.addEventListener('change', () => {
    chrome.storage.local.set({ clearEvents: clearEventsToggle.checked });
  });
```

Add the Eval Interceptor toggle listener immediately after it:

```javascript
  evalInterceptorToggle.addEventListener('change', () => {
    chrome.storage.local.set({ evalInterceptorEnabled: evalInterceptorToggle.checked });
  });
```

- [ ] **Step 4: Wire the pattern input**

Add these listeners after the toggle listener from the previous step:

```javascript
  function saveEvalPattern() {
    const raw = evalPatternInput.value.trim();
    if (raw) {
      try {
        // Parse /pattern/flags syntax if provided, otherwise treat as raw pattern
        const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
        new RegExp(match ? match[1] : raw, match ? match[2] : ''); // validate
        evalPatternError.textContent = '';
      } catch (e) {
        evalPatternError.textContent = 'Invalid regex: ' + e.message;
        return;
      }
    } else {
      evalPatternError.textContent = '';
    }
    chrome.storage.local.set({ evalInterceptorPattern: raw });
  }

  evalPatternInput.addEventListener('blur', saveEvalPattern);
  evalPatternInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { saveEvalPattern(); evalPatternInput.blur(); }
  });
```

- [ ] **Step 5: End-to-end verification**

1. Reload the extension
2. Open the popup, toggle "Eval Interceptor" ON
3. Type `hello` in the Debugger Pattern field and press Enter
4. Open a tab, DevTools Console, run:
   ```js
   eval('console.log("hello world")');
   ```
   Expected: DevTools pauses at `debugger;` inside a file named `eval-interceptor://eval-1.js` in the Sources panel

5. Now run:
   ```js
   eval('console.log("unrelated code")');
   ```
   Expected: runs without pausing; Sources panel shows `eval-interceptor://eval-2.js` (named file, no break)

6. Toggle "Eval Interceptor" OFF in the popup (no page reload needed)
7. Run `eval('hello')` again — should run without any sourceURL or debugger

- [ ] **Step 6: Verify Function constructor patching**

In DevTools Console (with interceptor ON, pattern `hello`):
```js
const fn = new Function('return "hello from Function"');
fn();
```
Expected: DevTools pauses at `debugger;` inside `eval-interceptor://Function-N.js`

Also verify instanceof is preserved:
```js
new Function('return 1') instanceof Function  // must return true
```

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/popup.js
git commit -m "feat: wire eval interceptor toggle and pattern input to chrome.storage"
```
