# Rule Outcome Inspector — Design

**Date:** 2026-04-19
**Scope:** Chrome extension (`eval-interceptor.js`, `content.js`, `panel.js`)
**Status:** Approved for implementation planning

## Goal

Surface the return value of each intercepted `Custom-Rule-*` eval in the DevTools panel, so the developer can see at a glance whether a rule passed, failed, or threw — without opening the Sources tab or setting a breakpoint.

## Non-goals

- Inspecting *why* a rule passed or failed (no input/condition breakdown — the eval'd code only exposes `builderId`).
- Capturing outcomes for `Campaign-*` tags (campaigns don't return meaningful values).
- Capturing outcomes for rules that arrive via `script-interceptor.js`. Rules in practice flow through `eval`, not `<script>` injection. If we ever see a `Custom-Rule-*` classified from a script tag, it simply won't get an outcome — same as today.
- Persisting outcomes across sessions.
- Capturing stack traces (message only, to keep tooltips terse).

## User-facing behaviour

Each `Custom-Rule-*` row in the Interceptor panel gains an outcome icon rendered inline, before the tag name. Three states plus empty:

| State | Icon | Colour | Meaning |
|-------|------|--------|---------|
| empty | (placeholder) | — | Row was classified but the rule has not yet been evaluated this session. Reserves width so alignment doesn't jump. |
| pass | ✓ | green | Last invocation returned a truthy value. |
| fail | ✗ | red | Last invocation returned a falsy value. |
| error | ⚠ | orange | Last invocation threw. |

Latest outcome overwrites the previous one. No outcome history is shown.

Tooltip on the icon:
- pass: `Last outcome: passed (HH:MM:SS)`
- fail: `Last outcome: failed (HH:MM:SS)`
- error: `Last outcome: errored: <message> (HH:MM:SS)`

Campaign rows are unchanged.

## Data flow

```
eval-interceptor.js  (MAIN world)
  │
  ├─ classifier.js fires  postMessage { source: 'li-classifier', tag }   [unchanged, pre-eval]
  │
  └─ after eval completes/throws, fires  postMessage { source: 'li-rule-outcome', tag, outcome, message? }   [new, post-eval]
         │
         ▼
content.js  (extension world)
  └─ forwards li-rule-outcome via chrome.runtime.sendMessage, same pattern as existing li-classifier forwarding
         │
         ▼
panel.js
  └─ chrome.runtime.onMessage handler updates the rule row's outcome cell and tooltip
```

Two separate messages (classify pre-eval, outcome post-eval) — the classifier runs before the eval and cannot know the outcome, and keeping them decoupled avoids restructuring existing code.

## Wire format

```js
// Pass or fail
{ source: 'li-rule-outcome', tag: 'Custom-Rule-12345-3', outcome: 'pass' }
{ source: 'li-rule-outcome', tag: 'Custom-Rule-12345-3', outcome: 'fail' }

// Error
{ source: 'li-rule-outcome', tag: 'Custom-Rule-12345-3', outcome: 'error', message: 'x is not defined' }
```

- `tag` matches the tag string produced by the classifier, so the panel can key into the existing rule row map directly.
- `outcome` is one of `'pass' | 'fail' | 'error'`.
- `message` is present only when `outcome === 'error'`. Coerced via `String(e?.message ?? e)` and truncated to 200 characters.

## `eval-interceptor.js` changes

Today `liEval` returns the original eval result unobserved:

```js
function liEval(code) {
    if (typeof code !== 'string') return _eval.call(this, code);
    return _eval.call(this, wrapCode(code, 'eval'));
}
```

Updated:

```js
function liEval(code) {
    if (typeof code !== 'string') return _eval.call(this, code);
    const wrapped = wrapCode(code, 'eval');           // now returns {code, tag}
    const { code: wrappedCode, tag } = wrapped;
    const isRule = tag && tag.startsWith('Custom-Rule-');
    try {
        const result = _eval.call(this, wrappedCode);
        if (isRule) notifyOutcome(tag, result ? 'pass' : 'fail');
        return result;
    } catch (e) {
        if (isRule) notifyOutcome(tag, 'error', String(e?.message ?? e).slice(0, 200));
        throw e;  // must re-throw — swallowing would change page behaviour
    }
}
```

Supporting changes:

1. `wrapCode` returns `{code, tag}` instead of a bare string, so we don't classify twice. Internal refactor — only `liEval` calls it.
2. New `notifyOutcome(tag, outcome, message?)` helper wraps `window.postMessage({source:'li-rule-outcome', ...}, location.origin)` with a try/catch (postMessage can throw on detached windows, same caveat as the classifier).

The existing classifier notification path (`li-classifier`) is untouched.

## `content.js` changes

One additional listener branch in the existing `window.message` handler, forwarding `li-rule-outcome` to `chrome.runtime.sendMessage` the same way `li-classifier` is forwarded today. No new permissions, no new storage.

## `panel.js` changes

1. Extend the per-rule row state with `{ outcome: 'pass'|'fail'|'error'|null, outcomeAt: number|null, errorMessage: string|null }`. Initial state for a newly classified rule row is all-null.
2. Add a `chrome.runtime.onMessage` branch for `li-rule-outcome` payloads that updates the matching row's state and re-renders the outcome cell + tooltip.
3. Add a leading outcome cell to Custom-Rule rows only. Fixed width so empty state aligns with pass/fail/error. Campaign rows render without this cell.
4. CSS: three utility classes (`.li-outcome-pass`, `.li-outcome-fail`, `.li-outcome-error`) with the three colours. Respect the existing light/dark theme variables rather than hard-coding.

## Error handling

- eval throws: captured, outcome='error' notified, error re-thrown so Insider SDK semantics are preserved.
- postMessage fails (detached window): swallowed silently, matches existing classifier behaviour.
- `chrome.runtime.sendMessage` fails (service worker asleep, context gone): swallowed, matches existing forwarding.
- Non-Error throws (`throw 'string'`, `throw {...}`): `String(e?.message ?? e)` coercion handles both.

## Storage

In-memory only, same lifetime as the existing per-rule hit counter in the panel. No `chrome.storage.local` entry. Re-opening the panel or reloading the page resets outcomes — showing a stale outcome from a previous session would mislead the user.

## Testing notes

Manual test cases to cover after implementation:

1. Rule eval returns truthy → row shows ✓ with tooltip "passed".
2. Rule eval returns falsy (`false`, `0`, `null`, `undefined`) → row shows ✗ with tooltip "failed".
3. Rule eval throws a standard Error → row shows ⚠ with tooltip containing the error message.
4. Rule eval throws a non-Error value (string/object) → ⚠ shown, message still populated via coercion.
5. Rule eval throws → page-level behaviour unchanged (error still propagates to Insider SDK).
6. Multiple invocations of the same rule (`Custom-Rule-12345-1`, `-2`, `-3` …) → each row shows its own latest outcome independently.
7. Campaign eval runs → no outcome icon, no `li-rule-outcome` message on the wire.
8. Panel reopened mid-session → outcome state is cleared; rows re-populate as rules re-evaluate.
