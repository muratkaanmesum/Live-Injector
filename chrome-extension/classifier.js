// Shared classifier — Live Code Injector v2
// Exposes window.__liClassify(code, fallback, n) -> tag string.
// Runs in MAIN world at document_start, before eval/script interceptors.
(function () {
  'use strict';

  const CAMPAIGN_RE = /\bfunction\s*\(\s*camp\s*\)|\(\s*camp\s*\)\s*=>/;
  const CAMPAIGN_ID_RE = /\)\s*\(\s*\{\s*["']id["']\s*:\s*(\d+)/;
  const CUSTOM_RULE_RE = /customRuleDetail\s*=\s*\{[^}]*["']builderId["']\s*:\s*(\d+)/;

  // djb2 hash → decimal string. Stable per code body so repeated evals of
  // the same rule collapse onto one row when no ruleId is available.
  function hashCode(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
    return (h >>> 0).toString();
  }

  // Custom-Rule tags use a hash of the code body — stable across Insider
  // re-inits (same rule function + same builderId prefix → same hash), so
  // re-runs dedupe onto the existing row and distinct rules under the same
  // campaign get their own rows. Using the ruleId stashed by rules-interceptor
  // would race: the first call happens before our wrap lands, producing a
  // hash-based tag, while later calls would produce a ruleId-based tag and
  // duplicate. Hash always wins regardless of wrap timing. Campaign tags use
  // variationId alone — globally unique per campaign.
  window.__liClassify = function (code, fallback, n) {
    const rule = code.match(CUSTOM_RULE_RE);
    if (rule) return 'Custom-Rule-' + rule[1] + '-' + hashCode(code);
    if (CAMPAIGN_RE.test(code)) {
      const id = code.match(CAMPAIGN_ID_RE);
      if (id) return 'Campaign-' + id[1];
      return 'Campaign-' + hashCode(code);
    }
    return fallback + '-' + n;
  };

  const _liClassify = window.__liClassify;
  window.__liClassifyAndNotify = function (code, fallback, n) {
    const tag = _liClassify(code, fallback, n);
    if (tag.startsWith('Campaign-') || tag.startsWith('Custom-Rule-')) {
      try {
        window.postMessage({ source: 'li-classifier', tag: tag }, location.origin);
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
