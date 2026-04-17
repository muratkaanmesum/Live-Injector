# DevTools Panel — Campaign/Rule Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a DevTools panel that lists classified `Campaign-*` / `Custom-Rule-*` tags seen on the page with run counts, and per-origin "break on next run" toggles that inject `debugger;` into the next intercepted eval/script for that tag.

**Architecture:** Classifier emits `window.postMessage` when a tag is classified. `content.js` forwards tag-seen events to the DevTools panel via `chrome.runtime.sendMessage`, and bridges per-origin break-sets from `chrome.storage.local` to a `data-li-break-tags` attribute on `<html>`. Both interceptors read that dataset and prepend `debugger;\n` when the current tag is in the set.

**Tech Stack:** MV3 Chrome extension, vanilla JS, `chrome.devtools.panels`, `chrome.storage.local`, MAIN-world content scripts.

**Spec:** `docs/superpowers/specs/2026-04-17-devtools-panel-design.md`

**Testing note:** This project has no automated test harness. Each task ends with a manual verification step loaded in Chrome via `chrome://extensions` → reload unpacked → open DevTools on a target page. Where a task's behavior can't be observed standalone, verification is deferred to a later task and called out.

---

## File Structure

**Create:**
- `chrome-extension/devtools.html` — blank page that registers the panel.
- `chrome-extension/devtools.js` — calls `chrome.devtools.panels.create`.
- `chrome-extension/panel.html` — the panel's UI markup.
- `chrome-extension/panel.js` — panel logic (origin resolution, tag list, break toggles).

**Modify:**
- `chrome-extension/manifest.json` — add `devtools_page`.
- `chrome-extension/classifier.js` — add `__liClassifyAndNotify`.
- `chrome-extension/eval-interceptor.js` — call notifier, honor break set.
- `chrome-extension/script-interceptor.js` — call notifier, honor break set.
- `chrome-extension/content.js` — tag-seen bridge + break-set bridge.

---

## Task 1: Add `__liClassifyAndNotify` to classifier

**Files:**
- Modify: `chrome-extension/classifier.js`

- [ ] **Step 1: Add the notifier wrapper**

Open `chrome-extension/classifier.js`. After the existing `window.__liClassify = function (...)` assignment (currently lines 17–32), add this **inside the same IIFE**, before the closing `})();`:

```js
  window.__liClassifyAndNotify = function (code, fallback, n) {
    const tag = window.__liClassify(code, fallback, n);
    if (tag.startsWith('Campaign-') || tag.startsWith('Custom-Rule-')) {
      try {
        window.postMessage({ source: 'li-classifier', tag: tag }, '*');
      } catch (_) { /* postMessage can throw on detached windows */ }
    }
    return tag;
  };
```

- [ ] **Step 2: Verify in Chrome**

Reload the extension at `chrome://extensions`. Open DevTools on any page that runs classified eval and in the Console run:

```js
window.addEventListener('message', e => e.data?.source === 'li-classifier' && console.log('TAG:', e.data.tag));
```

Then reload the page. Nothing will log yet (interceptors still call the old function) — this step just confirms the file loaded without errors. Check the Console for `Uncaught SyntaxError` referencing `classifier.js`; none should appear.

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/classifier.js
git commit -m "feat(classifier): add __liClassifyAndNotify wrapper"
```

---

## Task 2: Switch eval-interceptor to notifier + add break-tag injection

**Files:**
- Modify: `chrome-extension/eval-interceptor.js`

- [ ] **Step 1: Replace the `classify` + `wrapCode` block**

In `chrome-extension/eval-interceptor.js`, find the current `classify` and `wrapCode` functions (the block starting with `function classify(code, fallback, n) {` through the closing `}` of `wrapCode`). Replace that entire block with:

```js
  function classify(code, fallback, n) {
    const fn = window.__liClassifyAndNotify || window.__liClassify;
    return fn ? fn(code, fallback, n) : fallback + '-' + n;
  }

  let warnedBadBreakSet = false;
  function getBreakSet() {
    const raw = document.documentElement.dataset.liBreakTags;
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length ? new Set(arr) : null;
    } catch (e) {
      if (!warnedBadBreakSet) {
        console.warn('[eval-interceptor] invalid data-li-break-tags:', e.message);
        warnedBadBreakSet = true;
      }
      return null;
    }
  }

  function wrapCode(code, fallbackTag) {
    const n = ++counter;
    const tag = classify(code, fallbackTag, n);
    const isClassified = tag.startsWith('Campaign-') || tag.startsWith('Custom-Rule-');
    if (!isClassified) return code;
    const breakSet = getBreakSet();
    const breakLine = breakSet && breakSet.has(tag) ? 'debugger;\n' : '';
    return breakLine + code + '\n//# sourceURL=eval-interceptor://' + tag + '.js';
  }
```

- [ ] **Step 2: Verify no runtime errors**

Reload the extension. Visit a page that runs classified eval. Open DevTools → Sources → there should still be virtual files under `eval-interceptor://Campaign-*.js`. Console should show no errors from `eval-interceptor.js`.

- [ ] **Step 3: Verify break injection end-to-end using a manual dataset write**

While on the page, in DevTools Console:

```js
document.documentElement.dataset.liBreakTags = JSON.stringify(['Campaign-123']);
```

Replace `Campaign-123` with a tag actually visible in Sources (base name, drop the trailing counter — e.g., `Campaign-123` matches `Campaign-123-7.js`).

Wait — the tag string the interceptor checks includes the trailing `-n` counter. We need the exact tag. Easier: pick a real tag from Sources (e.g., `Campaign-42-3`) and use it verbatim. Then trigger another eval (reload the page or re-run the action that generates that tag family — note the counter will be different on reload, so reload and immediately set the dataset before the tagged code runs).

Cleanest verification path: reload page, pause at "DOMContentLoaded" via a DevTools breakpoint, set the dataset, continue. The debugger should pause inside the tagged eval on its next run this session.

If this verification is cumbersome at this stage, defer it to Task 10 where the panel will set the dataset automatically.

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/eval-interceptor.js
git commit -m "feat(eval-interceptor): use classifier notifier and honor break tags"
```

---

## Task 3: Switch script-interceptor to notifier + add break-tag injection

**Files:**
- Modify: `chrome-extension/script-interceptor.js`

- [ ] **Step 1: Replace the `tagScript` function**

In `chrome-extension/script-interceptor.js`, find the current `tagScript` function (currently lines 20–36). Replace it with:

```js
  let warnedBadBreakSet = false;
  function getBreakSet() {
    const raw = document.documentElement.dataset.liBreakTags;
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length ? new Set(arr) : null;
    } catch (e) {
      if (!warnedBadBreakSet) {
        console.warn('[script-interceptor] invalid data-li-break-tags:', e.message);
        warnedBadBreakSet = true;
      }
      return null;
    }
  }

  function tagScript(node) {
    if (!node || node.tagName !== 'SCRIPT') return;
    if (node.__liTagged) return;
    node.__liTagged = true;

    if (node.src) return;
    const code = node.textContent || '';
    if (!code) return;
    if (!code.includes('Insider')) return;

    const n = ++counter;
    const classify = window.__liClassifyAndNotify || window.__liClassify || function (_c, f, i) { return f + '-' + i; };
    const tag = classify(code, 'script', n);
    if (!tag.startsWith('Campaign-')) return;

    const breakSet = getBreakSet();
    const breakLine = breakSet && breakSet.has(tag) ? 'debugger;\n' : '';
    node.textContent = breakLine + code + '\n//# sourceURL=script-interceptor://' + tag + '.js';
  }
```

- [ ] **Step 2: Verify no runtime errors**

Reload the extension. Visit a page that loads inline campaign `<script>` tags (same page from Task 2). No console errors from `script-interceptor.js`.

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/script-interceptor.js
git commit -m "feat(script-interceptor): use classifier notifier and honor break tags"
```

---

## Task 4: Add tag-seen bridge to content.js

**Files:**
- Modify: `chrome-extension/content.js`

- [ ] **Step 1: Append the tag-seen listener**

In `chrome-extension/content.js`, just before the final `})();` that closes the IIFE, add:

```js
  // ── Tag-seen bridge (MAIN world → DevTools panel) ────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.source !== 'li-classifier' || !data.tag) return;
    try {
      chrome.runtime.sendMessage({
        type: 'li-tag-seen',
        tag: data.tag,
        origin: location.origin
      });
    } catch (_) { /* runtime may be unavailable during tab teardown */ }
  });
```

- [ ] **Step 2: Verify the bridge in Chrome**

Reload the extension. Open DevTools on a page with classified eval. In the **background service worker** console (click "service worker" link under the extension on `chrome://extensions`) — or easier, in any open DevTools Console — run:

```js
chrome.runtime.onMessage.addListener(m => m?.type === 'li-tag-seen' && console.log('SEEN:', m.tag, m.origin));
```

Note: `chrome.runtime.onMessage` only fires inside extension pages. To verify the bridge without a panel yet, check the background worker's logs — but with no listener there, the message will just be a no-op. **This step is best deferred to Task 9 where the panel is the consumer.** Mark this step complete once the file parses without error (reload the page, no console errors from `content.js`).

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/content.js
git commit -m "feat(content): bridge classifier tag-seen events to runtime messages"
```

---

## Task 5: Add break-set bridge to content.js

**Files:**
- Modify: `chrome-extension/content.js`

- [ ] **Step 1: Append the break-set bridge**

In `chrome-extension/content.js`, just before the final `})();` (and after the tag-seen listener added in Task 4), add:

```js
  // ── Break-set bridge (chrome.storage → MAIN world dataset) ───────
  function applyBreakSet(map) {
    const list = (map && map[location.origin]) || [];
    document.documentElement.dataset.liBreakTags = JSON.stringify(list);
  }

  chrome.storage.local.get(['liBreakTags'], (result) => {
    applyBreakSet(result.liBreakTags || {});
  });
```

Then find the existing `chrome.storage.onChanged.addListener(function (changes, area) { ... })` block in the same file and add this inside it, after the existing `if ('scriptInterceptorEnabled' in changes)` check:

```js
    if ('liBreakTags' in changes) {
      applyBreakSet(changes.liBreakTags.newValue || {});
    }
```

- [ ] **Step 2: Verify dataset is set**

Reload the extension, reload the page. In the Console:

```js
document.documentElement.dataset.liBreakTags
```

Expected output: `'[]'` (empty array as JSON string). If `undefined`, the bridge didn't run — check for `chrome.storage.local.get` errors in the Console.

- [ ] **Step 3: Verify storage changes propagate**

In the same Console:

```js
chrome.storage.local.set({ liBreakTags: { [location.origin]: ['Test-Tag'] } });
```

Then immediately re-read `document.documentElement.dataset.liBreakTags`. Expected: `'["Test-Tag"]'`. Clean up:

```js
chrome.storage.local.remove('liBreakTags');
```

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/content.js
git commit -m "feat(content): bridge per-origin break-tags from storage to dataset"
```

---

## Task 6: Register the DevTools page

**Files:**
- Create: `chrome-extension/devtools.html`
- Create: `chrome-extension/devtools.js`
- Modify: `chrome-extension/manifest.json`

- [ ] **Step 1: Create `devtools.html`**

Write `chrome-extension/devtools.html`:

```html
<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /></head>
  <body><script src="devtools.js"></script></body>
</html>
```

- [ ] **Step 2: Create `devtools.js`**

Write `chrome-extension/devtools.js`:

```js
chrome.devtools.panels.create(
  'Live Injector',
  null,
  'panel.html',
  () => { /* panel registered */ }
);
```

- [ ] **Step 3: Wire it up in `manifest.json`**

In `chrome-extension/manifest.json`, add a top-level field (insert after the `"background"` block, before `"content_scripts"`):

```json
  "devtools_page": "devtools.html",
```

Remember trailing comma. The final manifest should have `"devtools_page": "devtools.html"` as a sibling of `"background"` and `"content_scripts"`.

- [ ] **Step 4: Verify the panel appears**

Reload the extension at `chrome://extensions`. Open DevTools on any page. In the top tab bar (next to Console, Sources, etc.) you should see **Live Injector**. Clicking it shows a blank panel (panel.html is empty — Task 7 adds UI). No errors in the DevTools-on-DevTools inspector.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/devtools.html chrome-extension/devtools.js chrome-extension/manifest.json
git commit -m "feat: register DevTools page and panel entry point"
```

---

## Task 7: Scaffold panel UI

**Files:**
- Create: `chrome-extension/panel.html`

- [ ] **Step 1: Write `panel.html`**

Write `chrome-extension/panel.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        margin: 0;
        padding: 12px;
        color: #222;
        background: #fff;
      }
      header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      h1 { font-size: 13px; margin: 0; font-weight: 600; }
      #origin { font-size: 11px; color: #888; font-family: monospace; }
      #empty {
        color: #888;
        padding: 20px 0;
        text-align: center;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-family: monospace;
      }
      th, td {
        text-align: left;
        padding: 4px 8px;
        border-bottom: 1px solid #eee;
      }
      th {
        font-weight: 600;
        color: #555;
        background: #fafafa;
      }
      td.count { text-align: right; width: 60px; color: #555; }
      td.toggle { width: 60px; text-align: center; }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <header>
      <h1>Live Injector — Classified Tags</h1>
      <span id="origin">—</span>
    </header>
    <div id="empty">No classified tags yet. Reload the page to capture.</div>
    <table id="tags" class="hidden">
      <thead>
        <tr><th>Tag</th><th class="count">Count</th><th class="toggle">Break</th></tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <script src="panel.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Verify it renders**

Reload extension, open DevTools, click **Live Injector**. You should see the header "Live Injector — Classified Tags", the origin placeholder `—`, and the empty state message.

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/panel.html
git commit -m "feat(panel): scaffold HTML and styles"
```

---

## Task 8: Resolve origin in panel

**Files:**
- Create: `chrome-extension/panel.js`

- [ ] **Step 1: Write initial `panel.js` with origin resolution**

Write `chrome-extension/panel.js`:

```js
// DevTools panel — Live Injector
(function () {
  'use strict';

  const originEl = document.getElementById('origin');
  const emptyEl  = document.getElementById('empty');
  const tableEl  = document.getElementById('tags');
  const rowsEl   = document.getElementById('rows');

  let currentOrigin = null;

  function setOrigin(origin) {
    currentOrigin = origin && origin !== 'null' ? origin : null;
    originEl.textContent = currentOrigin || 'no origin';
  }

  function resolveOrigin() {
    if (!chrome.devtools || !chrome.devtools.inspectedWindow) {
      setOrigin(null);
      return;
    }
    chrome.devtools.inspectedWindow.eval('location.origin', (result, err) => {
      if (err) { setOrigin(null); return; }
      setOrigin(result);
    });
  }

  resolveOrigin();
  if (chrome.devtools && chrome.devtools.network) {
    chrome.devtools.network.onNavigated.addListener(resolveOrigin);
  }

  // Tag-seen and break-set wiring added in later tasks.
})();
```

- [ ] **Step 2: Verify origin displays**

Reload extension. Open DevTools on any http/https page, click **Live Injector**. The right side of the header should show the current origin (e.g., `https://example.com`). Navigate to a different origin and confirm it updates.

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/panel.js
git commit -m "feat(panel): resolve and display current inspected origin"
```

---

## Task 9: Render seen tags in panel

**Files:**
- Modify: `chrome-extension/panel.js`

- [ ] **Step 1: Add the tag map, rendering, and message listener**

In `chrome-extension/panel.js`, replace the `// Tag-seen and break-set wiring added in later tasks.` comment with:

```js
  const counts = new Map(); // tag -> count
  const rowEls = new Map(); // tag -> <tr>

  function render() {
    if (counts.size === 0) {
      emptyEl.classList.remove('hidden');
      tableEl.classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    tableEl.classList.remove('hidden');
  }

  function upsertRow(tag) {
    let row = rowEls.get(tag);
    if (!row) {
      row = document.createElement('tr');
      const tagCell   = document.createElement('td');
      const countCell = document.createElement('td');
      const toggleCell = document.createElement('td');
      tagCell.textContent   = tag;
      countCell.className   = 'count';
      toggleCell.className  = 'toggle';
      row.appendChild(tagCell);
      row.appendChild(countCell);
      row.appendChild(toggleCell);
      rowsEl.appendChild(row);
      rowEls.set(tag, row);
    }
    row.children[1].textContent = String(counts.get(tag) || 0);
  }

  function handleTagSeen(tag) {
    counts.set(tag, (counts.get(tag) || 0) + 1);
    upsertRow(tag);
    render();
  }

  function clearTags() {
    counts.clear();
    rowEls.clear();
    rowsEl.textContent = '';
    render();
  }

  const inspectedTabId = chrome.devtools && chrome.devtools.inspectedWindow
    ? chrome.devtools.inspectedWindow.tabId
    : null;

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'li-tag-seen' || !msg.tag) return;
    if (inspectedTabId != null && sender.tab && sender.tab.id !== inspectedTabId) return;
    handleTagSeen(msg.tag);
  });

  if (chrome.devtools && chrome.devtools.network) {
    chrome.devtools.network.onNavigated.addListener(clearTags);
  }
```

The existing `chrome.devtools.network.onNavigated.addListener(resolveOrigin)` call should stay — we now have two listeners on `onNavigated`, one to clear tags and one to re-resolve origin.

- [ ] **Step 2: Verify tags appear end-to-end**

Reload the extension. Enable the **Eval Interceptor** toggle in the popup. Visit a page that runs classified eval. Open DevTools → **Live Injector**. Tags should start appearing with incrementing counts.

If no tags appear:
- Confirm the popup toggle is on (check `chrome.storage.local.get('evalInterceptorEnabled')` in the background console).
- Confirm the page actually matches `CAMPAIGN_RE` or `CUSTOM_RULE_RE` — inspect Sources for `eval-interceptor://Campaign-*.js` files.
- Open the panel's own inspector (undock the main DevTools, right-click the panel tab → Inspect) and check for runtime errors.

Reload the page → counts reset to 0 (per spec decision B) and repopulate.

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/panel.js
git commit -m "feat(panel): list classified tags with live run counts"
```

---

## Task 10: Break-toggle per tag

**Files:**
- Modify: `chrome-extension/panel.js`

- [ ] **Step 1: Add break-set state, toggle rendering, and storage sync**

In `chrome-extension/panel.js`, insert the break-set logic. Place it **after** the `rowEls` declaration and **before** the `render()` function:

```js
  let breakSet = new Set(); // tags to break on for current origin

  function toggleAllowed() {
    return currentOrigin != null;
  }

  function readBreakSetFromStorage() {
    chrome.storage.local.get(['liBreakTags'], (res) => {
      const map = res.liBreakTags || {};
      const list = (currentOrigin && map[currentOrigin]) || [];
      breakSet = new Set(list);
      rowEls.forEach((_row, tag) => upsertRow(tag));
    });
  }

  function writeBreakSetToStorage() {
    if (!currentOrigin) return;
    chrome.storage.local.get(['liBreakTags'], (res) => {
      const map = res.liBreakTags || {};
      map[currentOrigin] = Array.from(breakSet);
      chrome.storage.local.set({ liBreakTags: map }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[panel] failed to persist break set:', chrome.runtime.lastError.message);
        }
      });
    });
  }
```

Next, replace the existing `upsertRow` function with:

```js
  function upsertRow(tag) {
    let row = rowEls.get(tag);
    if (!row) {
      row = document.createElement('tr');
      const tagCell    = document.createElement('td');
      const countCell  = document.createElement('td');
      const toggleCell = document.createElement('td');
      const toggleInput = document.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.addEventListener('change', () => {
        if (toggleInput.checked) breakSet.add(tag);
        else breakSet.delete(tag);
        writeBreakSetToStorage();
      });
      tagCell.textContent  = tag;
      countCell.className  = 'count';
      toggleCell.className = 'toggle';
      toggleCell.appendChild(toggleInput);
      row.appendChild(tagCell);
      row.appendChild(countCell);
      row.appendChild(toggleCell);
      rowsEl.appendChild(row);
      rowEls.set(tag, row);
    }
    row.children[1].textContent = String(counts.get(tag) || 0);
    const input = row.children[2].firstChild;
    input.checked  = breakSet.has(tag);
    input.disabled = !toggleAllowed();
  }
```

Finally, add storage synchronization. Near the bottom of the IIFE (before the closing `})();`) add:

```js
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('liBreakTags' in changes)) return;
    readBreakSetFromStorage();
  });
```

And make sure `readBreakSetFromStorage` runs whenever the origin changes. Update the existing `setOrigin` function to also refresh the break set:

```js
  function setOrigin(origin) {
    currentOrigin = origin && origin !== 'null' ? origin : null;
    originEl.textContent = currentOrigin || 'no origin';
    readBreakSetFromStorage();
  }
```

- [ ] **Step 2: Verify toggle flow end-to-end**

Reload the extension. Visit a page with classified eval. Open **Live Injector** panel.

a) Check a break toggle for a visible tag (e.g., `Campaign-123-7`). In the page's own Console run:

```js
document.documentElement.dataset.liBreakTags
```

Expected: the JSON includes `"Campaign-123-7"`.

b) Reload the page (hard reload). In the Console check again — the tag should still be in the dataset (persistence across reload per spec decision B).

c) Trigger the classified code path that produces that tag. The debugger should pause inside the wrapped eval. Resume.

d) Uncheck the toggle in the panel, reload, and confirm the debugger no longer pauses.

- [ ] **Step 3: Verify per-origin isolation**

Navigate the inspected tab to a different origin that also runs classified code with the same Campaign/Custom-Rule ID (if available — otherwise mock via Console: `chrome.storage.local.set({ liBreakTags: { 'https://otherorigin.com': ['Campaign-123-7'] } })`). Confirm `document.documentElement.dataset.liBreakTags` on the current origin is `'[]'`.

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/panel.js
git commit -m "feat(panel): per-origin break toggles wired to storage and interceptors"
```

---

## Task 11: Final verification pass

**Files:** none — verification only.

Walk through the spec's verification checklist (§ Verification) end-to-end in a single session. No new code.

- [ ] **Step 1: Run the eight verification scenarios**

From `docs/superpowers/specs/2026-04-17-devtools-panel-design.md` § Verification:

1. Load unpacked extension, open DevTools → **Live Injector** panel appears.
2. Visit page with classified eval/script → tags appear with correct counts.
3. Toggle break on a tag, reload page → breakpoint hits when tag's code runs.
4. Untoggle → reload, no pause.
5. Same tag on a different origin → no break (use two tabs or navigate).
6. Disable eval interceptor toggle in popup → no new tags appear; existing rows remain until reload.
7. SPA pushState navigation → origin unchanged, existing counts persist.
8. Hard reload → seen-tag counts reset, break toggles preserved.

- [ ] **Step 2: If all pass, create the final commit**

If any fix was needed during verification, it should have been committed in that scenario's own task. This step only runs if nothing broke:

```bash
git log --oneline | head -12
```

Confirm the 10 feature commits from Tasks 1–10 are present.

---

## Out of scope (do not implement)

- Icon for the panel tab.
- Row context menu, copy-tag, clear-counts buttons.
- Surfacing unclassified tags (fallback names like `eval-1`).
- Import/export of break sets.
- Automated tests (none exist in the extension today).
