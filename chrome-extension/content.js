// Content script — Live Code Injector v2
(function () {
  'use strict';

  // Deduplicate the animation style — inject once, reuse forever
  let animationStyleInjected = false;

  function ensureAnimationStyle() {
    if (animationStyleInjected || document.getElementById('live-injector-anim')) { return; }
    const style = document.createElement('style');
    style.id = 'live-injector-anim';
    style.textContent = `
      @keyframes liSlideIn {
        from { transform: translateX(100%); opacity: 0; }
        to   { transform: translateX(0);   opacity: 1; }
      }
    `;
    document.head.appendChild(style);
    animationStyleInjected = true;
  }

  function showNotification(filename, codeType) {
    ensureAnimationStyle();

    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 50px;
      right: 10px;
      background: #2196F3;
      color: white;
      padding: 8px 12px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 11px;
      z-index: 999999;
      pointer-events: none;
      animation: liSlideIn 0.3s ease-out;
    `;
    notification.textContent = `Executed: ${filename} (${codeType})`;
    document.body.appendChild(notification);

    setTimeout(() => { notification.remove(); }, 2000);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'code-executed') {
      showNotification(message.filename, message.codeType);
    }
  });

  // ── Eval interceptor config bridge ───────────────────────────────
  // eval-interceptor.js runs in MAIN world and cannot access chrome.storage.
  // We bridge settings via dataset attributes on <html> so both worlds can read them.

  function applyEvalConfig(enabled, pattern) {
    document.documentElement.dataset.liEvalEnabled = enabled ? 'true' : 'false';
    document.documentElement.dataset.liEvalPattern = pattern || '';
  }

  chrome.storage.local.get(['evalInterceptorEnabled', 'evalInterceptorPattern'], function (result) {
    applyEvalConfig(result.evalInterceptorEnabled || false, result.evalInterceptorPattern || '');
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (!('evalInterceptorEnabled' in changes) && !('evalInterceptorPattern' in changes)) return;
    chrome.storage.local.get(['evalInterceptorEnabled', 'evalInterceptorPattern'], function (result) {
      applyEvalConfig(result.evalInterceptorEnabled || false, result.evalInterceptorPattern || '');
    });
  });
})();
