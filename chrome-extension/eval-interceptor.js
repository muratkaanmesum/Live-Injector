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
    catch (e) { console.warn('[eval-interceptor] invalid pattern:', e.message); return false; }
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
