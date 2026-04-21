// Content script — Live Code Injector v2
(function () {
  'use strict';

  function showNotification(filename, codeType) {
    const name = filename || 'unknown';
    const kind = codeType || 'file';

    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none;';

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        @keyframes liIn {
          from { transform: translateX(calc(100% + 24px)); opacity: 0; }
          to   { transform: translateX(0); opacity: 1; }
        }
        .toast {
          display: flex; align-items: baseline; gap: 6px;
          background: oklch(0.21 0.005 60);
          border: 1px solid oklch(0.29 0.005 60);
          box-shadow: 0 4px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
          border-radius: 6px; padding: 7px 11px;
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
          font-size: 11px; white-space: nowrap;
          animation: liIn 0.25s cubic-bezier(0.2,0,0,1) forwards;
        }
        .label { color: oklch(0.56 0.006 60); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
        .file  { color: oklch(0.82 0.15 26); }
        .badge {
          color: oklch(0.56 0.006 60); background: oklch(0.17 0.005 60);
          border: 1px solid oklch(0.29 0.005 60);
          border-radius: 3px; font-size: 9.5px; padding: 1px 5px;
        }
      </style>
      <div class="toast">
        <span class="label">injected</span>
        <span class="file"></span>
        <span class="badge"></span>
      </div>
    `;
    shadow.querySelector('.file').textContent = name;
    shadow.querySelector('.badge').textContent = kind;

    document.documentElement.appendChild(host);
    setTimeout(() => { host.remove(); }, 2500);
  }

  // ── Event history (for DevTools panel late-open replay) ─────────
  // Content script is the only long-lived per-frame actor, so we buffer
  // classified events here. When the panel opens mid-session it asks for
  // a replay and we re-emit every buffered event through the same path as
  // live ones — the SW relays them to the panel port unchanged.
  const HISTORY_CAP = 500;
  const history = [];

  function recordAndForward(payload) {
    if (history.length >= HISTORY_CAP) history.shift();
    history.push(payload);
    try {
      chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
    } catch (_) { /* runtime may be unavailable during tab teardown */ }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'code-executed') {
      showNotification(message.filename, message.codeType);
      return;
    }
    if (message.type === 'li-replay-request') {
      for (let i = 0; i < history.length; i++) {
        try {
          chrome.runtime.sendMessage(history[i], () => void chrome.runtime.lastError);
        } catch (_) { /* tab teardown */ }
      }
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

  function applyRulesConfig(enabled) {
    document.documentElement.dataset.liRulesEnabled = enabled ? 'true' : 'false';
  }

  chrome.storage.local.get(
    ['evalInterceptorEnabled', 'scriptInterceptorEnabled', 'rulesInterceptorEnabled'],
    function (result) {
      const evalOn   = result.evalInterceptorEnabled   ?? true;
      const scriptOn = result.scriptInterceptorEnabled ?? true;
      const rulesOn  = result.rulesInterceptorEnabled  ?? true;
      applyEvalConfig(evalOn);
      applyScriptConfig(scriptOn);
      applyRulesConfig(rulesOn);
      const toSet = {};
      if (result.evalInterceptorEnabled   === undefined) toSet.evalInterceptorEnabled   = true;
      if (result.scriptInterceptorEnabled === undefined) toSet.scriptInterceptorEnabled = true;
      if (result.rulesInterceptorEnabled  === undefined) toSet.rulesInterceptorEnabled  = true;
      if (Object.keys(toSet).length) chrome.storage.local.set(toSet);
    }
  );

  // ── Break-set bridge (chrome.storage → MAIN world dataset) ───────
  function applyBreakSet(map) {
    const list = (map && map[location.origin]) || [];
    const next = JSON.stringify(list);
    if (document.documentElement.dataset.liBreakTags !== next) {
      document.documentElement.dataset.liBreakTags = next;
    }
  }

  chrome.storage.local.get(['liBreakTags'], (result) => {
    applyBreakSet(result.liBreakTags || {});
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if ('evalInterceptorEnabled' in changes) {
      applyEvalConfig(changes.evalInterceptorEnabled.newValue ?? true);
    }
    if ('scriptInterceptorEnabled' in changes) {
      applyScriptConfig(changes.scriptInterceptorEnabled.newValue ?? true);
    }
    if ('rulesInterceptorEnabled' in changes) {
      applyRulesConfig(changes.rulesInterceptorEnabled.newValue ?? true);
    }
    if ('liBreakTags' in changes) {
      applyBreakSet(changes.liBreakTags.newValue || {});
    }
  });

  // ── Tag-seen bridge (MAIN world → SW → DevTools panel port) ──────
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const data = e.data;
    if (!data) return;

    if (data.source === 'li-classifier' && data.tag) {
      recordAndForward({
        type: 'li-tag-seen',
        tag: data.tag,
        hasShow: !!data.hasShow,
        origin: location.origin,
      });
      return;
    }

    if (data.source === 'li-rule-outcome' && data.tag && data.outcome) {
      recordAndForward({
        type: 'li-rule-outcome',
        tag: data.tag,
        outcome: data.outcome,
        message: data.message,
        origin: location.origin
      });
      return;
    }

    if (data.source === 'li-rule-call' && data.id != null) {
      recordAndForward({
        type: 'li-rule-call',
        id: data.id,
        builderId: data.builderId,
        ok: data.ok,
        result: data.result,
        durationMs: data.durationMs,
        error: data.error,
        ts: data.ts,
        origin: location.origin
      });
    }
  });
})();
