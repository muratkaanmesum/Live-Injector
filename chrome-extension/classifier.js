// Shared classifier — Live Code Injector v2
// Exposes window.__liClassify(code, fallback, n) -> tag string.
// Runs in MAIN world at document_start, before eval/script interceptors.
(function () {
  'use strict';

  const CAMPAIGN_RE = /\bfunction\s*\(\s*camp\s*\)|\(\s*camp\s*\)\s*=>/;
  const CAMPAIGN_ID_RE = /\)\s*\(\s*\{\s*["']id["']\s*:\s*(\d+)/;
  const CUSTOM_RULE_RE = /customRuleDetail\s*=\s*\{[^}]*["']builderId["']\s*:\s*(\d+)/;

  window.__liClassify = function (code, fallback, n) {
    const rule = code.match(CUSTOM_RULE_RE);
    if (rule) return 'Custom-Rule-' + rule[1];
    if (CAMPAIGN_RE.test(code)) {
      const id = code.match(CAMPAIGN_ID_RE);
      return id ? 'Campaign-' + id[1] : 'Campaign-' + n;
    }
    return fallback + '-' + n;
  };
})();
