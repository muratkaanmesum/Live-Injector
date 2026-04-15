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

  function getConfig() {
    const ds = document.documentElement.dataset;
    return {
      enabled: ds.liEvalEnabled === 'true',
      pattern: ds.liEvalPattern || ''
    };
  }

  function shouldBreak(code, pattern) {
    if (!pattern) return false;
    try {
      const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
      const re = m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
      return re.test(code);
    }
    catch (e) { console.warn('[eval-interceptor] invalid pattern:', e.message); return false; }
  }

  function classify(code, fallback, n) {
    const fn = window.__liClassify;
    return fn ? fn(code, fallback, n) : fallback + '-' + n;
  }

  function wrapCode(code, fallbackTag) {
    const { pattern } = getConfig();
    const n = ++counter;
    const tag = classify(code, fallbackTag, n);
    const isClassified = tag.startsWith('Campaign-') || tag.startsWith('Custom-Rule-');
    const needsBreak = shouldBreak(code, pattern);
    if (!isClassified && !needsBreak) return code;
    const breakLine = needsBreak ? 'debugger;\n' : '';
    if (!isClassified) return breakLine + code;
    return breakLine + code + '\n//# sourceURL=eval-interceptor://' + tag + '.js';
  }

  function liEval(code) {
    if (typeof code !== 'string') return _eval.call(this, code);
    return _eval.call(this, wrapCode(code, 'eval'));
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
    getConfig().enabled ? install() : uninstall();
  }

  // Apply current state (dataset may already be set if content.js ran first)
  sync();

  // Watch for popup toggle changes bridged via dataset
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-li-eval-enabled']
  });

})();
