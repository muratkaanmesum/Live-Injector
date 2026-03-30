# Eval Interceptor — Design Spec
_Date: 2026-03-29_

## Overview

Add an eval/Function interceptor to the Live Code Injector Chrome extension. When enabled, it monkey-patches `window.eval` and `window.Function` in the page's MAIN world so that eval'd code appears as named files in DevTools (instead of `VM###`) and optionally auto-breaks with `debugger;` when the code matches a user-supplied regex pattern.

No logging is produced. The feature is purely about making dynamically evaluated code debuggable.

---

## Files

| File | Action |
|---|---|
| `chrome-extension/eval-interceptor.js` | **Create** — MAIN world patch script |
| `chrome-extension/manifest.json` | **Modify** — register `eval-interceptor.js` as a MAIN world content script at `document_start` |
| `chrome-extension/content.js` | **Modify** — read settings from storage and write to `<html>` dataset bridge; keep updated via `chrome.storage.onChanged` |
| `chrome-extension/popup.html` | **Modify** — add "Eval Interceptor" toggle section and regex pattern input |
| `chrome-extension/popup.js` | **Modify** — load/save `evalInterceptorEnabled` and `evalInterceptorPattern` storage keys |

---

## Storage

Two new keys in `chrome.storage.local`:

| Key | Type | Default | Description |
|---|---|---|---|
| `evalInterceptorEnabled` | boolean | `false` | Master on/off for the interceptor |
| `evalInterceptorPattern` | string | `''` | Regex pattern string; empty means no auto-break |

---

## Config Bridge

`eval-interceptor.js` runs in the MAIN world and cannot access `chrome.storage`. `content.js` runs in the isolated world and can.

**Bridge mechanism:** `content.js` reads both keys from storage on startup and writes them to `document.documentElement.dataset`:
- `data-li-eval-enabled` — `"true"` or `"false"`
- `data-li-eval-pattern` — the raw regex string

`content.js` also listens to `chrome.storage.onChanged` and updates the dataset attributes whenever either key changes, so the interceptor picks up live changes without a page reload.

`eval-interceptor.js` reads from the dataset on every interception call (not at setup time), so toggling the popup takes effect immediately for subsequent evals.

---

## eval-interceptor.js

Runs immediately at `document_start`, before any page script.

### eval patch

Saves original as `const _eval = window.eval`, then replaces `window.eval` with a wrapper that:
1. Passes non-string arguments through untouched (spec-compliant)
2. If disabled → returns `_eval(code)` unchanged
3. If enabled → appends `\n//# sourceURL=eval-interceptor://eval-N.js` and optionally prepends `debugger;\n` if the pattern matches

### Function patch

Uses a `Proxy` over the original `Function` with `construct` and `apply` traps. The Proxy approach is required (vs a plain wrapper function) to preserve `instanceof Function`, `Function.prototype`, and `fn.constructor` checks that libraries depend on.

Both traps apply the same wrap logic to the last argument (the function body string).

### sourceURL naming

Format: `eval-interceptor://eval-N.js` / `eval-interceptor://Function-N.js` where N is a per-page monotonic counter. DevTools uses this as the filename in the Sources panel.

### Pattern matching

```js
function shouldBreak(code, pattern) {
  if (!pattern) return false;
  try { return new RegExp(pattern).test(code); }
  catch { return false; }
}
```

Invalid regex emits `console.warn('[eval-interceptor] invalid pattern: ...')` in the page's DevTools console and returns false (no break). Visible to the developer; does not affect page behaviour.

### Disabled path

When `evalInterceptorEnabled` is `false`, both patches are no-ops — the original code string is passed through untouched with zero transformation overhead.

---

## Popup UI

New section added above the Reconnect button, matching the existing `toggle-section` + `preamble-section` visual pattern:

1. **Eval Interceptor toggle** — `toggle-section` with label "Eval Interceptor" and sub-label "sourceURL + debugger; on match". Toggle wired to `evalInterceptorEnabled`.

2. **Pattern input** — shown below the toggle (always visible, not conditional on toggle state). Single-line `<input type="text">` with placeholder `/myFunction|someModule/i`. Saves on blur/Enter. Wired to `evalInterceptorPattern`.

---

## Trade-offs & Known Limitations

- **Direct eval scope semantics:** Intercepting `eval` converts direct eval calls to indirect evals, losing local-scope access. This is acceptable for the target use case (debugging generated/minified third-party code) where local-scope eval is not used.
- **CSP:** `eval-interceptor.js` is an extension content script in MAIN world and bypasses page CSP entirely — works on all sites.
- **Ordering:** Both content scripts declare `run_at: document_start`. `content.js` is listed first in the manifest and writes the dataset synchronously on storage load. `eval-interceptor.js` is listed second and reads the dataset on each call (not at module init), so there's no race on first eval.
- **Counter resets on navigation** — expected behaviour.
