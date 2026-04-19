# Rule Outcome Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the return value of each intercepted `Custom-Rule-*` eval and surface it as a pass/fail/error icon on the rule's row in the Interceptor panel.

**Architecture:** `eval-interceptor.js` wraps the real `eval` in a try/catch, determines tag via the existing classifier, and fires a second `postMessage` (`li-rule-outcome`) after eval completes. `content.js` forwards that message to `chrome.runtime` exactly like it forwards `li-classifier` today. `panel.js` receives it via `chrome.runtime.onMessage`, updates the row's in-memory state, and re-renders a small inline icon on the row.

**Tech Stack:** Plain ES2018+ JavaScript, no build step. Three Chrome extension files: `eval-interceptor.js` (MAIN world), `content.js` (extension world), `panel.js` + `panel.html` (DevTools panel).

**Testing note:** The project has no test framework. Each task ends with a **manual verification** step — a snippet to paste into the inspected page's DevTools console to validate behaviour. "PASS/FAIL" expectations are described, not automated.

**Spec:** `docs/superpowers/specs/2026-04-19-rule-outcome-inspector-design.md`

---

### Task 1: `eval-interceptor.js` — return `{code, tag}` from `wrapCode`

**Files:**
- Modify: `chrome-extension/eval-interceptor.js:29-37`

Preparatory refactor. `wrapCode` currently returns a string; callers need the classified tag too. Changing the return shape first keeps the next task's diff focused on the try/catch logic.

- [ ] **Step 1: Update `wrapCode` to return `{code, tag}`**

Replace the existing function body:

```js
function wrapCode(code, fallbackTag) {
    const n = ++counter;
    const tag = classify(code, fallbackTag, n);
    const isClassified = tag.startsWith('Campaign-') || tag.startsWith('Custom-Rule-');
    if (!isClassified) return { code, tag };
    const breakSet = getBreakSet();
    const breakLine = breakSet && breakSet.has(tag) ? 'debugger;\n' : '';
    return {
        code: breakLine + code + '\n//# sourceURL=eval-interceptor://' + tag + '.js',
        tag
    };
}
```

- [ ] **Step 2: Update `liEval` call site**

```js
function liEval(code) {
    if (typeof code !== 'string') return _eval.call(this, code);
    const wrapped = wrapCode(code, 'eval');
    return _eval.call(this, wrapped.code);
}
```

- [ ] **Step 3: Manual verification**

1. Reload the extension at `chrome://extensions`.
2. Reload any page that triggers Insider eval interception.
3. In the Interceptor DevTools panel, confirm that rules and campaigns still appear exactly as before (sparklines, break checkbox, grouping all intact).

Expected: no visible behavioural change. This task is a pure refactor.

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/eval-interceptor.js
git commit -m "refactor(eval-interceptor): wrapCode returns {code, tag}"
```

---

### Task 2: `eval-interceptor.js` — capture outcome and notify

**Files:**
- Modify: `chrome-extension/eval-interceptor.js:39-42` (liEval body)
- Modify: `chrome-extension/eval-interceptor.js` (add `notifyOutcome` helper)

- [ ] **Step 1: Add `notifyOutcome` helper**

Insert just below the `classify` helper (around line 23):

```js
function notifyOutcome(tag, outcome, message) {
    const payload = { source: 'li-rule-outcome', tag, outcome };
    if (message !== undefined) payload.message = message;
    try {
        window.postMessage(payload, location.origin);
    } catch (_) { /* postMessage can throw on detached windows */ }
}
```

- [ ] **Step 2: Wrap `liEval` in try/catch and emit outcomes**

Replace `liEval`:

```js
function liEval(code) {
    if (typeof code !== 'string') return _eval.call(this, code);
    const wrapped = wrapCode(code, 'eval');
    const isRule = wrapped.tag && wrapped.tag.startsWith('Custom-Rule-');
    try {
        const result = _eval.call(this, wrapped.code);
        if (isRule) notifyOutcome(wrapped.tag, result ? 'pass' : 'fail');
        return result;
    } catch (e) {
        if (isRule) {
            const message = String(e && e.message != null ? e.message : e).slice(0, 200);
            notifyOutcome(wrapped.tag, 'error', message);
        }
        throw e;
    }
}
```

- [ ] **Step 3: Manual verification — pass/fail outcomes emitted**

Reload the extension. Open the Interceptor panel's DevTools-on-DevTools (right-click panel → Inspect), and in its console paste:

```js
window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'li-rule-outcome') console.log('[outcome]', e.data);
});
```

This listener won't fire in the panel context — the `postMessage` happens in the inspected page. Move to the **inspected page's DevTools console** instead and paste the same listener. Then trigger rule evaluations (reload the page or interact with it).

Expected: `[outcome] { source: 'li-rule-outcome', tag: 'Custom-Rule-12345-1', outcome: 'pass' }` (or `'fail'`) appears per rule invocation.

- [ ] **Step 4: Manual verification — errors are captured AND re-thrown**

In the inspected page's DevTools console, paste:

```js
// Simulate a rule eval that throws
eval(`var customRuleDetail = { builderId: 99999 }; throw new Error('rule bug')`);
```

Expected:
1. The listener logs `{ source: 'li-rule-outcome', tag: 'Custom-Rule-99999-<n>', outcome: 'error', message: 'rule bug' }`.
2. The `eval(...)` call itself throws `Error: rule bug` (visible in the console).

Both must happen. If the error is swallowed, it's a bug — re-read the spec's "error handling" section.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/eval-interceptor.js
git commit -m "feat(eval-interceptor): emit rule outcome on eval completion"
```

---

### Task 3: `content.js` — forward `li-rule-outcome` to `chrome.runtime`

**Files:**
- Modify: `chrome-extension/content.js:108-119` (existing `li-classifier` forwarder)

- [ ] **Step 1: Extend the window.message listener**

Replace the existing block starting at line 108 (`// ── Tag-seen bridge`) with:

```js
  // ── Tag-seen bridge (MAIN world → DevTools panel) ────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const data = e.data;
    if (!data) return;

    if (data.source === 'li-classifier' && data.tag) {
      try {
        chrome.runtime.sendMessage(
          { type: 'li-tag-seen', tag: data.tag, origin: location.origin },
          () => void chrome.runtime.lastError
        );
      } catch (_) { /* runtime may be unavailable during tab teardown */ }
      return;
    }

    if (data.source === 'li-rule-outcome' && data.tag && data.outcome) {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'li-rule-outcome',
            tag: data.tag,
            outcome: data.outcome,
            message: data.message,
            origin: location.origin
          },
          () => void chrome.runtime.lastError
        );
      } catch (_) { /* runtime may be unavailable during tab teardown */ }
    }
  });
```

- [ ] **Step 2: Manual verification**

Reload the extension. In the Interceptor DevTools panel, right-click → **Inspect** to open DevTools-on-DevTools. In its console, paste:

```js
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'li-rule-outcome') console.log('[panel-recv]', msg);
});
```

Reload the inspected page so rules evaluate.

Expected: `[panel-recv] { type: 'li-rule-outcome', tag: 'Custom-Rule-...', outcome: 'pass'|'fail', origin: 'https://...' }` logs for each rule invocation.

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/content.js
git commit -m "feat(content): forward li-rule-outcome to runtime"
```

---

### Task 4: `panel.js` — handle `li-rule-outcome`, track per-row state

**Files:**
- Modify: `chrome-extension/panel.js:590-688` (upsertRow — attach outcome element)
- Modify: `chrome-extension/panel.js:447-453` (syncInstanceRow — render outcome)
- Modify: `chrome-extension/panel.js:830-847` (clearTags — reset outcomes)
- Modify: `chrome-extension/panel.js:990-995` (onMessage listener — branch for li-rule-outcome)

- [ ] **Step 1: Create a module-level outcome map**

Add near the top of the IIFE alongside `counts`, `rowEls`, etc. (search for `const counts = new Map();` — add directly after it):

```js
  const outcomes = new Map(); // tag -> { outcome: 'pass'|'fail'|'error', at: number, message: string|null }
```

- [ ] **Step 2: Build outcome element in `upsertRow`**

Inside `upsertRow`, just before `row.appendChild(dotEl);` (around line 646), add:

```js
      const outcomeEl = document.createElement('span');
      outcomeEl.className = 'instance-outcome';
      if (!parsed || parsed.type !== 'Custom-Rule') {
        outcomeEl.classList.add('instance-outcome--hidden');
      }
```

Update the append block to insert `outcomeEl` between `dotEl` and `badge`:

```js
      row.appendChild(dotEl);
      row.appendChild(outcomeEl);
      row.appendChild(badge);
      row.appendChild(sparklineEl);
      row.appendChild(toggleInput);
      group.bodyEl.appendChild(row);
```

And store the reference on the row (add alongside the existing `row._countCell = countCell;` line):

```js
      row._outcomeEl = outcomeEl;
```

- [ ] **Step 3: Render outcome in `syncInstanceRow`**

Extend `syncInstanceRow` (line 447) to set the outcome icon and tooltip:

```js
  function syncInstanceRow(row) {
    row._countCell.textContent = String(counts.get(row._tag) || 0);
    row._toggleInput.checked   = breakSet.has(row._tag);
    row.classList.toggle('is-breaking', breakSet.has(row._tag));
    const heights = sparklineHeights(row._tag);
    row._sparkBars.forEach((bar, i) => { bar.style.height = heights[i] + '%'; });

    const el = row._outcomeEl;
    if (!el) return;
    el.classList.remove('is-pass', 'is-fail', 'is-error');
    const o = outcomes.get(row._tag);
    if (!o) {
      el.textContent = '';
      el.removeAttribute('title');
      return;
    }
    const when = new Date(o.at).toTimeString().slice(0, 8);
    if (o.outcome === 'pass') {
      el.textContent = '✓';
      el.classList.add('is-pass');
      el.title = `Last outcome: passed (${when})`;
    } else if (o.outcome === 'fail') {
      el.textContent = '✗';
      el.classList.add('is-fail');
      el.title = `Last outcome: failed (${when})`;
    } else {
      el.textContent = '⚠';
      el.classList.add('is-error');
      el.title = `Last outcome: errored: ${o.message || ''} (${when})`;
    }
  }
```

- [ ] **Step 4: Reset outcomes in `clearTags`**

Extend `clearTags` (line 830). Add `outcomes.clear();` alongside the other `.clear()` calls:

```js
  function clearTags() {
    counts.clear();
    rowEls.clear();
    groups.clear();
    builderMetaCache.clear();
    varIdToBuilder.clear();
    resolvingVarIds.clear();
    resolvingBuilderIds.clear();
    hitLog.clear();
    outcomes.clear();
    if (pendingGroup) {
      pendingGroup.groupEl.remove();
      pendingGroup = null;
    }
    rowsEl.textContent = '';
    totalHits = 0;
    render();
    updateStatusBar();
  }
```

- [ ] **Step 5: Listen for `li-rule-outcome` in `chrome.runtime.onMessage`**

Extend the existing listener (line 990). Replace the block:

```js
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg) return;
    if (inspectedTabId != null && sender.tab && sender.tab.id !== inspectedTabId) return;

    if (msg.type === 'li-tag-seen' && msg.tag) {
      if (!currentOrigin && msg.origin) setOrigin(msg.origin);
      handleTagSeen(msg.tag);
      return;
    }

    if (msg.type === 'li-rule-outcome' && msg.tag && msg.outcome) {
      outcomes.set(msg.tag, {
        outcome: msg.outcome,
        at: Date.now(),
        message: msg.message || null
      });
      const row = rowEls.get(msg.tag);
      if (row) syncInstanceRow(row);
    }
  });
```

- [ ] **Step 6: Manual verification**

Reload the extension. Open a page with rule evaluations. Open the Interceptor panel.

Expected:
- Custom-Rule rows show an outcome icon (`✓` or `✗` — or `⚠` if any rule errored).
- Campaign rows show no icon (space is reserved via CSS — wait, that's Task 5; for now Campaign rows will show an empty `<span>` with no visible content).
- Hover the icon: tooltip reads `Last outcome: passed (HH:MM:SS)` etc.
- Re-trigger a rule and the icon updates to reflect the latest outcome.

If no icon appears but the wire verification from Task 3 worked, check browser console for errors in `panel.js` and verify `rowEls.get(msg.tag)` returns the row (the tag must already be classified before outcome arrives — classifier fires before eval in the same call path).

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/panel.js
git commit -m "feat(panel): render rule outcome icon on Custom-Rule rows"
```

---

### Task 5: `panel.html` — outcome cell CSS

**Files:**
- Modify: `chrome-extension/panel.html` (add CSS rules)

- [ ] **Step 1: Locate the `.instance` block**

Open `panel.html`. Find the existing `.instance` CSS rule (search for `.instance {` — it should define the grid/flex layout of the row and be near the other instance-related styles like `.instance-dot`, `.sparkline`).

- [ ] **Step 2: Add outcome CSS**

Immediately after the existing `.instance-dot` block, add:

```css
    .instance-outcome {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      min-width: 14px;
      height: 14px;
      font-size: 12px;
      line-height: 1;
      font-weight: 700;
      color: var(--li-muted, #8a8a8a);
      user-select: none;
    }
    .instance-outcome--hidden {
      visibility: hidden;
    }
    .instance-outcome.is-pass  { color: var(--li-ok, #3ecf8e); }
    .instance-outcome.is-fail  { color: var(--li-err, #ef4444); }
    .instance-outcome.is-error { color: var(--li-warn, #f59e0b); }
```

The three colours fall back to hard-coded hex if the theme variables don't exist. If `panel.html` already defines `--li-ok` / `--li-err` / `--li-warn` for the light/dark themes, leave them alone; if not, the fallbacks are fine for now — polish later.

- [ ] **Step 3: Manual verification**

Reload the extension. Reload a page with rules.

Expected:
- Icons are colour-coded: green `✓`, red `✗`, orange `⚠`.
- Campaign rows have the outcome element present but invisible (check: they shouldn't shift horizontally relative to rule rows).
- Rule rows without outcome-yet show an empty 14px gutter where the icon will eventually appear — no horizontal shift when the icon populates.
- In both light and dark theme (toggle via the panel UI), icons are readable.

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/panel.html
git commit -m "style(panel): outcome icon colours for Custom-Rule rows"
```

---

### Task 6: End-to-end manual test

**Files:** none

- [ ] **Step 1: Full scenario walkthrough**

With the extension reloaded, on a page that runs Insider rules, verify every test case from the spec:

1. **Pass:** trigger a rule that returns truthy → row shows green ✓, tooltip "passed".
2. **Fail — falsy values:** rule returning each of `false`, `0`, `null`, `undefined`, `''`, `NaN` → row shows red ✗.
3. **Error — standard Error:** paste in console `eval("var customRuleDetail={builderId:88888}; throw new Error('boom')")` → row shows orange ⚠, tooltip contains "boom", AND console shows the original error (not swallowed).
4. **Error — non-Error throw:** paste `eval("var customRuleDetail={builderId:77777}; throw 'stringy'")` → row shows ⚠, tooltip contains "stringy".
5. **Multiple invocations per rule:** same rule invoked repeatedly → icon always reflects the LATEST outcome (not the first).
6. **Campaign rows:** unchanged. No icon visible.
7. **Panel reopen:** close and reopen DevTools panel → outcomes cleared; repopulate as rules fire again.
8. **Page navigation:** navigate in-place to a new URL → `clearTags` fires, outcome map clears, rules re-evaluate and icons reappear.

- [ ] **Step 2: Smoke the unhappy paths**

- Disable the eval interceptor via the panel chip → no `li-rule-outcome` messages should be emitted (confirm with the Task 2 console listener).
- Re-enable it → outcomes resume without reload.

- [ ] **Step 3: Final commit (if any cleanup needed)**

If any polish emerged from walkthrough, commit it. Otherwise this task ends without a commit.
