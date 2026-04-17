# DevTools Panel — Campaign/Rule Picker

**Date:** 2026-04-17
**Status:** Design

## Problem

The eval and script interceptors classify eval'd code and inline scripts as `Campaign-X` or `Custom-Rule-Y`. Today users can see the tag only via the `//# sourceURL=` line in DevTools Sources. There is no way to:

1. See which classified tags have actually run on the current page.
2. Set a breakpoint scoped to a specific tag so that the next eval/script carrying that tag halts execution.

The previous global regex field (removed 2026-04-17) tried to solve (2) but had no per-campaign granularity and applied across all eval'd code. This spec replaces it with a focused UI.

## Goals

- Give users a live list of classified tags seen on the current page, with run counts.
- Let users toggle a per-tag "break on next run" that prepends `debugger;` inside the intercepted code.
- Scope break toggles per-origin so staging and production have independent break sets.
- Persist break toggles across reloads; seen-tag counts are per-session and reset on reload.

## Non-goals

- Jump-to-source buttons. The existing `//# sourceURL=` already makes the file findable via Cmd+P in Sources.
- Skip/no-op execution for a tag. Risky and confusing; out of scope.
- Tag sources beyond the existing classifier (future interceptors will work automatically if they use `__liClassify`).
- Automated tests. Verification is manual, consistent with the rest of the extension.

## Architecture

A new DevTools panel (`devtools_page`) named **Live Injector** binds to two flows:

```
MAIN world                 Isolated (content.js)          DevTools panel
──────────                 ─────────────────────          ──────────────
classifier emits tag   →   window.message listener
                           → chrome.runtime.sendMessage  →  onMessage (filter by tabId)
                                                            → update Map<tag, count>
                                                            → rerender

panel break toggle    ←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←   chrome.storage.local.set
                           storage.onChanged
                           → write data-li-break-tags
interceptor reads
dataset, prepends debugger
```

**Tag-seen (page → panel):** `classifier.js` exposes a new notifier wrapper. When an interceptor asks to classify code, the wrapper calls the existing classification, and if the result is a `Campaign-*` or `Custom-Rule-*` tag, posts a `window.postMessage` announcing it. `content.js` listens for that message and forwards via `chrome.runtime.sendMessage` with the current `location.origin`. The panel filters incoming messages by `chrome.devtools.inspectedWindow.tabId` so one panel instance only sees its own tab.

**Break-set (panel → page):** The panel writes `chrome.storage.local.liBreakTags = { [origin]: [tag, ...] }`. `content.js` reads this on startup and on `storage.onChanged`, picks the set for the current origin, and writes it as a JSON string to `document.documentElement.dataset.liBreakTags`. Both interceptors read that dataset attribute; if the tag they're about to emit is in the parsed set, they prepend `debugger;\n` to the wrapped code.

## Components

### `classifier.js` (modified)

Add `window.__liClassifyAndNotify(code, fallback, n)`:

1. Delegates to existing `__liClassify(code, fallback, n)`.
2. If the result starts with `Campaign-` or `Custom-Rule-`, dispatch `window.postMessage({ source: 'li-classifier', tag }, '*')`.
3. Returns the tag.

Interceptors switch from calling `__liClassify` to `__liClassifyAndNotify` so emission is centralized. `__liClassify` stays exported for any caller that wants classification without notification.

### `eval-interceptor.js` (modified)

- Read `document.documentElement.dataset.liBreakTags` at wrap time; `JSON.parse` it inside a try/catch. On parse failure, treat as empty and `console.warn` once per page load.
- If the computed tag is in the set, prepend `debugger;\n` to the wrapped code before appending the sourceURL line.
- Call `__liClassifyAndNotify` instead of `__liClassify`.

### `script-interceptor.js` (modified)

Same three changes as `eval-interceptor.js`, applied to the script wrap path.

### `content.js` (modified)

New responsibilities, additive to existing config bridge:

1. **Tag-seen bridge:** `window.addEventListener('message', e => { if (e.data?.source === 'li-classifier') chrome.runtime.sendMessage({ type: 'li-tag-seen', tag: e.data.tag, origin: location.origin }); })`.
2. **Break-set bridge:** on load and on `storage.onChanged`, read `liBreakTags[location.origin]` and write it (JSON-stringified) into `dataset.liBreakTags`. If absent, write `'[]'`.

### `devtools.html` + `devtools.js` (new)

`devtools.html` loads `devtools.js` which calls `chrome.devtools.panels.create('Live Injector', null, 'panel.html')`. Icon field left null for now.

### `panel.html` + `panel.js` (new)

`panel.html` is a simple document with a header, an empty-state message, and a `<table id="tags">` with columns Tag | Count | Break. `panel.js`:

1. Resolves the current origin via `chrome.devtools.inspectedWindow.eval('location.origin', (result) => ...)`. Re-resolves on `chrome.devtools.network.onNavigated` to handle SPA-unfriendly reloads.
2. Maintains an in-memory `Map<tag, count>`. On each `chrome.runtime.onMessage` of type `li-tag-seen` where `sender.tab.id === chrome.devtools.inspectedWindow.tabId`, increments the count and rerenders the row.
3. On `chrome.devtools.network.onNavigated`, clears the tag map (per-session reset) but keeps break toggles (they live in storage).
4. Reads `chrome.storage.local.liBreakTags[origin]` on load and on `storage.onChanged` to reflect toggle state. Toggle changes write the updated array back to storage under the current origin.

### `manifest.json` (modified)

Add top-level `"devtools_page": "devtools.html"`. No changes to content_scripts or permissions (storage is already granted).

## Storage schema

```
chrome.storage.local.liBreakTags = {
  "https://example.com": ["Campaign-123", "Custom-Rule-7"],
  "https://staging.example.com": ["Campaign-456"]
}
```

Origin keys are the output of `location.origin` (scheme + host + port). Tags stored verbatim.

Dataset mirror, refreshed by `content.js`:

```
<html data-li-break-tags='["Campaign-123","Custom-Rule-7"]'>
```

## Error handling

- **Invalid JSON in `dataset.liBreakTags`:** interceptors treat as empty set and `console.warn` once.
- **`chrome.devtools` APIs missing** (panel loaded outside DevTools): panel renders a static empty-state message; no listeners registered.
- **Origin resolves to `null`, `"null"`, or `about:blank`:** panel shows "No origin — break toggles disabled" and disables toggle inputs. Tag list still renders.
- **Storage write failures:** toggle reverts visually and `console.warn` in the panel. Not surfaced to the user beyond that; these are rare and transient.

## Verification

Manual, consistent with existing extension. After loading unpacked:

1. Open DevTools on any page → **Live Injector** panel appears.
2. Visit a page with classified eval/script → tags appear in the table with run counts that increment on reloads.
3. Toggle break on `Campaign-X`, reload → debugger pauses when `Campaign-X` code runs.
4. Untoggle → reload, no pause.
5. Same `Campaign-X` on a different origin → no pause (per-origin isolation).
6. Disable eval interceptor toggle in popup → no new tags appear; existing rows remain until reload.
7. Navigate within an SPA (pushState) → origin stays the same, existing counts persist (acceptable per decision B).
8. Hard-reload → seen-tag counts reset, break toggles preserved.

## Out-of-scope follow-ups

- Icon for panel tab.
- Tag row context menu (copy tag, clear counts, etc.).
- Surfacing unclassified eval/script tags (fallback names like `eval-1`).
- Export/import of break sets.
