// Shared classifier — Live Code Injector v2
// Exposes window.__liClassify(code, fallback, n) -> tag string.
// Runs in MAIN world at document_start, before eval/script interceptors.
(function () {
  'use strict';

  const CAMPAIGN_RE = /\bfunction\s*\(\s*camp\s*\)|\(\s*camp\s*\)\s*=>/;
  const CAMPAIGN_ID_RE = /\)\s*\(\s*\{\s*["']id["']\s*:\s*(\d+)/;
  const CUSTOM_RULE_RE = /customRuleDetail\s*=\s*\{[^}]*["']builderId["']\s*:\s*(\d+)/;

  const counters = Object.create(null);
  function nextFor(key) {
    counters[key] = (counters[key] || 0) + 1;
    return counters[key];
  }

  window.__liClassify = function (code, fallback, n) {
    const rule = code.match(CUSTOM_RULE_RE);
    if (rule) {
      const key = 'Custom-Rule-' + rule[1];
      return key + '-' + nextFor(key);
    }
    if (CAMPAIGN_RE.test(code)) {
      const id = code.match(CAMPAIGN_ID_RE);
      if (id) {
        const key = 'Campaign-' + id[1];
        return key + '-' + nextFor(key);
      }
      return 'Campaign-' + n;
    }
    return fallback + '-' + n;
  };

  const _liClassify = window.__liClassify;
  window.__liClassifyAndNotify = function (code, fallback, n) {
    const tag = _liClassify(code, fallback, n);
    if (tag.startsWith('Campaign-') || tag.startsWith('Custom-Rule-')) {
      try {
        window.postMessage({ source: 'li-classifier', tag: tag }, '*');
      } catch (_) { /* postMessage can throw on detached windows */ }
    }
    return tag;
  };

  let _breakSetWarned = false;
  window.__liGetBreakSet = function () {
    const raw = document.documentElement.dataset.liBreakTags;
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length ? new Set(arr) : null;
    } catch (e) {
      if (!_breakSetWarned) {
        console.warn('[li-classifier] invalid data-li-break-tags:', e.message);
        _breakSetWarned = true;
      }
      return null;
    }
  };
})();
