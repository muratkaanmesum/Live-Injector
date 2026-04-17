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

  function applyEvalConfig(enabled) {
    document.documentElement.dataset.liEvalEnabled = enabled ? 'true' : 'false';
  }

  function applyScriptConfig(enabled) {
    document.documentElement.dataset.liScriptEnabled = enabled ? 'true' : 'false';
  }

  chrome.storage.local.get(
    ['evalInterceptorEnabled', 'scriptInterceptorEnabled'],
    function (result) {
      applyEvalConfig(result.evalInterceptorEnabled || false);
      applyScriptConfig(result.scriptInterceptorEnabled || false);
    }
  );

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if ('evalInterceptorEnabled' in changes) {
      applyEvalConfig(changes.evalInterceptorEnabled.newValue || false);
    }
    if ('scriptInterceptorEnabled' in changes) {
      applyScriptConfig(changes.scriptInterceptorEnabled.newValue || false);
    }
  });

  // ── Tag-seen bridge (MAIN world → DevTools panel) ────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.source !== 'li-classifier' || !data.tag) return;
    try {
      chrome.runtime.sendMessage({
        type: 'li-tag-seen',
        tag: data.tag,
        origin: location.origin
      });
    } catch (_) { /* runtime may be unavailable during tab teardown */ }
  });
})();
