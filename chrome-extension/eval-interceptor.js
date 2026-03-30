// Eval Interceptor — Live Code Injector v2
// Runs in MAIN world at document_start.
// Reads config from document.documentElement.dataset (written by content.js).
//
// Patches are installed LAZILY — only when evalInterceptorEnabled is true.
// When disabled, window.eval and window.Function are left completely untouched
// so page behaviour is unaffected.
(function () {
  'use strict';

  const _eval = window.eval;
  const _Function = window.Function;
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

  function wrapCode(code, tag) {
    const { pattern } = getConfig();
    const n = ++counter;
    const sourceURL = '\n//# sourceURL=eval-interceptor://' + tag + '-' + n + '.js';
    const breakLine = shouldBreak(code, pattern) ? 'debugger;\n' : '';
    return breakLine + code + sourceURL;
  }

  function liEval(code) {
    if (typeof code !== 'string') return _eval.call(this, code);
    return _eval.call(this, wrapCode(code, 'eval'));
  }

  const FunctionProxy = new Proxy(_Function, {
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

  // ── Lazy install / uninstall ──────────────────────────────────────

  function install() {
    if (installed) return;
    installed = true;
    window.eval = liEval;
    window.Function = FunctionProxy;
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    window.eval = _eval;
    window.Function = _Function;
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
