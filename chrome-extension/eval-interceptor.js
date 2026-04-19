// Eval Interceptor — Live Code Injector v2
// Runs in MAIN world at document_start.
// Reads config from document.documentElement.dataset (written by content.js).
//
// Patches are installed LAZILY — only when evalInterceptorEnabled is true.
// Only window.eval is intercepted. window.Function is intentionally left
// untouched: wrapping it (Proxy or plain fn) changes its identity and breaks
// Vue 2 template compilation on pages like optimus-insight /metrics.
(function () {
  'use strict';

  const _eval = window.eval;
  let counter = 0;
  let installed = false;

  function isEnabled() {
    return document.documentElement.dataset.liEvalEnabled === 'true';
  }

  function classify(code, fallback, n) {
    const fn = window.__liClassifyAndNotify || window.__liClassify;
    return fn ? fn(code, fallback, n) : fallback + '-' + n;
  }

  function getBreakSet() {
    return window.__liGetBreakSet ? window.__liGetBreakSet() : null;
  }

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

  function liEval(code) {
    if (typeof code !== 'string') return _eval.call(this, code);
    const wrapped = wrapCode(code, 'eval');
    return _eval.call(this, wrapped.code);
  }

  // ── Lazy install / uninstall ──────────────────────────────────────

  function install() {
    if (installed) return;
    installed = true;
    window.eval = liEval;
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    window.eval = _eval;
  }

  function sync() {
    isEnabled() ? install() : uninstall();
  }

  // Apply current state (dataset may already be set if content.js ran first)
  sync();

  // Watch for popup toggle changes bridged via dataset
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-li-eval-enabled', 'data-li-break-tags']
  });

})();
