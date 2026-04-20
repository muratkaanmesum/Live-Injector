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

  function isEnabled() {
    // Install by default; only uninstall if content.js wrote 'false'.
    return document.documentElement.dataset.liRulesEnabled !== 'false';
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

  // On-demand re-eval of a rule's test function with a //# sourceURL comment
  // so DevTools Sources shows it under rules-interceptor://Custom-Rule-<id>.js
  // — mirrors eval/script interceptors' tagging. Only triggered when the user
  // clicks the "src" button on a rule row in the panel; we don't re-eval
  // proactively because closures in test bodies would break silently.
  function annotateRuleTest(id, builderId) {
    try {
      const R = window.Insider && window.Insider.rules;
      if (!R) return false;
      const entry = R[id];
      if (!entry || typeof entry.test !== 'function') return false;
      if (entry.test.__liSourced) return true;
      const src = Function.prototype.toString.call(entry.test);
      const tagId = builderId != null ? builderId : id;
      const reEvaled = (0, eval)(
        '(' + src + ')\n//# sourceURL=rules-interceptor://Custom-Rule-' + tagId + '.js'
      );
      if (typeof reEvaled !== 'function') return false;
      reEvaled.__liSourced = true;
      entry.test = reEvaled;
      return true;
    } catch (_) {
      return false;
    }
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

  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-li-rules-enabled']
  });
})();
