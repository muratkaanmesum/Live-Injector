// Script Interceptor — Live Code Injector v2
// Runs in MAIN world at document_start.
// Patches Node.prototype.appendChild / insertBefore to tag inline <script>
// bodies with //# sourceURL so campaign/rule code shows up in DevTools Sources.
//
// Patches are installed LAZILY — only when scriptInterceptorEnabled is true.
(function () {
  'use strict';

  const _appendChild = Node.prototype.appendChild;
  const _insertBefore = Node.prototype.insertBefore;
  let counter = 0;
  let installed = false;

  function getConfig() {
    const ds = document.documentElement.dataset;
    return { enabled: ds.liScriptEnabled === 'true' };
  }

  let _cachedBreakSet = undefined;
  function getBreakSet() {
    if (_cachedBreakSet !== undefined) return _cachedBreakSet;
    _cachedBreakSet = window.__liGetBreakSet ? window.__liGetBreakSet() : null;
    return _cachedBreakSet;
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
    const isClassified = tag.startsWith('Campaign-') || tag.startsWith('Custom-Rule-');
    if (!isClassified) return;

    const breakSet = getBreakSet();
    const breakLine = breakSet && breakSet.has(tag) ? 'debugger;\n' : '';
    node.textContent = breakLine + code + '\n//# sourceURL=script-interceptor://' + tag + '.js';
  }

  function liAppendChild(node) {
    tagScript(node);
    return _appendChild.call(this, node);
  }

  function liInsertBefore(node, ref) {
    tagScript(node);
    return _insertBefore.call(this, node, ref);
  }

  // ── Lazy install / uninstall ──────────────────────────────────────

  function install() {
    if (installed) return;
    installed = true;
    Node.prototype.appendChild = liAppendChild;
    Node.prototype.insertBefore = liInsertBefore;
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    Node.prototype.appendChild = _appendChild;
    Node.prototype.insertBefore = _insertBefore;
  }

  function sync() {
    getConfig().enabled ? install() : uninstall();
  }

  sync();

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === 'data-li-break-tags') _cachedBreakSet = undefined;
    }
    sync();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-li-script-enabled', 'data-li-break-tags']
  });
})();
