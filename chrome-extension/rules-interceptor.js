// Rules Interceptor — Live Code Injector v2
// Runs in MAIN world at document_start.
// Wraps Insider.rules.call so every rule evaluation is streamed to the panel.
//
// Insider.rules is a singleton whose prototype holds rule entries keyed by
// numeric rule id: { test: Function, relationalRule: number[], isRelational }.
// The public API lives on the same prototype: call(id, builderId), getRuleContent,
// isRelational, relationalRule. See pandora/src/core/rules/Rules.js.
//
// Patch target is the prototype's `call` (not a bound method on the instance),
// so a single wrap covers every future invocation. We restore the original if
// the feature is toggled off.
(function () {
  'use strict';

  let installed = false;
  let patchedProto = null;
  let originalCall = null;
  let pollHandle = null;

  // tag → { id, builderId } for every rule we've observed via proto.call.
  // Populated lazily so re-annotation on break-toggle only touches rules we
  // know exist (avoids walking the whole Insider.rules prototype).
  const seenRules = new Map();

  function isEnabled() {
    // Install by default; only uninstall if content.js wrote 'false'.
    return document.documentElement.dataset.liRulesEnabled !== 'false';
  }

  function getBreakSet() {
    return window.__liGetBreakSet ? window.__liGetBreakSet() : null;
  }

  function isBreakpointed(tag) {
    const set = getBreakSet();
    return !!(set && set.has(tag));
  }

  function notify(payload) {
    try {
      window.postMessage(payload, location.origin);
    } catch (_) { /* detached window */ }
  }

  function wrapCall() {
    const R = window.Insider && window.Insider.rules;
    if (!R) return false;
    const proto = Object.getPrototypeOf(R);
    if (!proto || typeof proto.call !== 'function') return false;
    if (proto.__liCallPatched) return true;

    const _call = proto.call;
    proto.call = function liCall(id, builderId) {
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      // Register first sight of this rule and, if the user already flipped its
      // break checkbox before it ever fired, apply the break annotation now.
      if (id != null && builderId != null) {
        const tag = 'Custom-Rule-' + builderId + '-' + id;
        if (!seenRules.has(tag)) {
          seenRules.set(tag, { id: id, builderId: builderId });
          if (isBreakpointed(tag)) annotateRuleTest(id, builderId, true);
        }
      }
      let result;
      let errorMessage = null;
      try {
        result = _call.apply(this, arguments);
      } catch (err) {
        errorMessage = String(err && err.message != null ? err.message : err).slice(0, 200);
        notify({
          source: 'li-rule-call',
          id: id != null ? String(id) : null,
          builderId: builderId != null ? String(builderId) : null,
          ok: false,
          result: null,
          durationMs: roundMs(t0),
          error: errorMessage,
          ts: Date.now()
        });
        throw err;
      }
      notify({
        source: 'li-rule-call',
        id: id != null ? String(id) : null,
        builderId: builderId != null ? String(builderId) : null,
        ok: true,
        result: normaliseResult(result),
        durationMs: roundMs(t0),
        error: null,
        ts: Date.now()
      });
      return result;
    };
    proto.__liCallPatched = true;
    patchedProto = proto;
    originalCall = _call;
    return true;
  }

  // Re-eval a rule's test function so DevTools Sources shows it under
  // rules-interceptor://Custom-Rule-<builderId>-<ruleId>.js — mirrors the
  // eval/script interceptors' tagging. Opt-in because closures in test bodies
  // would break silently: src-button clicks and break-toggle flips.
  //
  // When withBreak is true, `debugger;` is injected as the first statement of
  // the function body so pauses land inside the rule's own source (not in
  // rules-interceptor.js). Toggling break off re-annotates without the line.
  function injectDebugger(src) {
    const firstBrace = src.indexOf('{');
    if (firstBrace !== -1) {
      return src.slice(0, firstBrace + 1) + '\ndebugger;' + src.slice(firstBrace + 1);
    }
    // Arrow-without-braces: `(a,b) => expr` or `a => expr` — rewrite with block.
    const arrow = src.match(/^(\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)\s*([\s\S]+)$/);
    if (arrow) return arrow[1] + ' { debugger; return (' + arrow[2] + '); }';
    return null;
  }

  function annotateRuleTest(id, builderId, withBreak) {
    try {
      const R = window.Insider && window.Insider.rules;
      if (!R) return false;
      const entry = R[id];
      if (!entry || typeof entry.test !== 'function') return false;
      const shouldBreak = !!withBreak;
      if (entry.test.__liSourced && entry.test.__liSourcedBreak === shouldBreak) return true;
      // Always derive from the ORIGINAL function so repeated re-annotations
      // don't stack (debugger; wrapped twice, double sourceURL comments, …).
      const origFn = entry.test.__liOrig || entry.test;
      const srcRaw = Function.prototype.toString.call(origFn);
      const src = shouldBreak ? (injectDebugger(srcRaw) || srcRaw) : srcRaw;
      const tagSuffix = builderId != null ? builderId + '-' + id : String(id);
      const tempKey = '__liTmpRule_' + tagSuffix;
      const body = 'window["' + tempKey + '"] = (' + src + ');\n'
                 + '//# sourceURL=rules-interceptor://Custom-Rule-' + tagSuffix + '.js';
      const scriptEl = document.createElement('script');
      scriptEl.textContent = body;
      (document.head || document.documentElement).appendChild(scriptEl);
      scriptEl.remove();
      const reEvaled = window[tempKey];
      try { delete window[tempKey]; } catch (_) { window[tempKey] = undefined; }
      if (typeof reEvaled !== 'function') return false;
      reEvaled.__liSourced = true;
      reEvaled.__liSourcedBreak = shouldBreak;
      reEvaled.__liOrig = origFn;
      entry.test = reEvaled;
      return true;
    } catch (_) {
      return false;
    }
  }

  // Re-annotate every seen rule to match the current break set. Called when
  // content.js mirrors a storage change into data-li-break-tags.
  function applyBreakState() {
    const R = window.Insider && window.Insider.rules;
    if (!R) return;
    seenRules.forEach((info, tag) => {
      const entry = R[info.id];
      if (!entry || typeof entry.test !== 'function') return;
      const want = isBreakpointed(tag);
      const have = !!entry.test.__liSourcedBreak;
      if (want === have) return;
      // Only re-annotate if the rule was already sourced, or we're turning
      // break on. Plain "off" on an un-sourced rule is a no-op.
      if (entry.test.__liSourced || want) {
        annotateRuleTest(info.id, info.builderId, want);
      }
    });
  }

  window.__liAnnotateRule = annotateRuleTest;

  function roundMs(t0) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    return Math.round((now - t0) * 100) / 100;
  }

  // Serialize primitive results directly, anything else becomes its type name.
  function normaliseResult(v) {
    const t = typeof v;
    if (v === null) return null;
    if (t === 'boolean' || t === 'number' || t === 'string') return v;
    if (t === 'undefined') return undefined;
    return '[' + t + ']';
  }

  function unwrapCall() {
    if (patchedProto && originalCall) {
      patchedProto.call = originalCall;
      delete patchedProto.__liCallPatched;
    }
    patchedProto = null;
    originalCall = null;
  }

  function startPolling() {
    if (pollHandle != null) return;
    let tries = 0;
    const maxTries = 600; // ~60s at 100ms
    pollHandle = setInterval(() => {
      tries++;
      if (!isEnabled()) { stopPolling(); return; }
      if (wrapCall()) { installed = true; stopPolling(); return; }
      if (tries >= maxTries) stopPolling();
    }, 100);
  }

  function stopPolling() {
    if (pollHandle != null) { clearInterval(pollHandle); pollHandle = null; }
  }

  function sync() {
    if (isEnabled()) {
      if (!installed) startPolling();
    } else {
      stopPolling();
      if (installed) { unwrapCall(); installed = false; }
    }
  }

  sync();

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === 'data-li-rules-enabled') sync();
      else if (m.attributeName === 'data-li-break-tags' && isEnabled()) applyBreakState();
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-li-rules-enabled', 'data-li-break-tags']
  });
})();
