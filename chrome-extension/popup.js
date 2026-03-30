// Popup script — Live Code Injector v2
document.addEventListener('DOMContentLoaded', function () {
  const statusEl      = document.getElementById('status');
  const statusText    = document.getElementById('status-text');
  const reconnectBtn  = document.getElementById('reconnect');
  const disconnectBtn = document.getElementById('disconnect');

  const preambleTA      = document.getElementById('preamble');
  const savePreamble    = document.getElementById('save-preamble');
  const saveStatus      = document.getElementById('save-status');

  const clearEventsToggle = document.getElementById('clear-events-toggle');

  const evalInterceptorToggle = document.getElementById('eval-interceptor-toggle');
  const evalPatternInput      = document.getElementById('eval-pattern');
  const evalPatternError      = document.getElementById('eval-pattern-error');

  // ── Load saved values ──────────────────────────────────────────

  chrome.storage.local.get(
    ['preamble', 'clearEvents', 'evalInterceptorEnabled', 'evalInterceptorPattern'],
    ({ preamble = '', clearEvents = false, evalInterceptorEnabled = false, evalInterceptorPattern = '' }) => {
      preambleTA.value              = preamble;
      clearEventsToggle.checked     = clearEvents;
      evalInterceptorToggle.checked = evalInterceptorEnabled;
      evalPatternInput.value        = evalInterceptorPattern;
    }
  );

  // ── Clear Events toggle ────────────────────────────────────────

  clearEventsToggle.addEventListener('change', () => {
    chrome.storage.local.set({ clearEvents: clearEventsToggle.checked });
  });

  evalInterceptorToggle.addEventListener('change', () => {
    chrome.storage.local.set({ evalInterceptorEnabled: evalInterceptorToggle.checked });
  });

  function saveEvalPattern() {
    const raw = evalPatternInput.value.trim();
    if (raw) {
      try {
        const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
        new RegExp(match ? match[1] : raw, match ? match[2] : '');
        evalPatternError.textContent = '';
      } catch (e) {
        evalPatternError.textContent = 'Invalid regex: ' + e.message;
        return;
      }
    } else {
      evalPatternError.textContent = '';
    }
    chrome.storage.local.set({ evalInterceptorPattern: raw });
  }

  evalPatternInput.addEventListener('blur', saveEvalPattern);
  evalPatternInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { saveEvalPattern(); evalPatternInput.blur(); }
  });

  // ── Save preamble ──────────────────────────────────────────────

  savePreamble.addEventListener('click', () => {
    chrome.storage.local.set({ preamble: preambleTA.value }, () => {
      if (chrome.runtime.lastError) { return; }
      saveStatus.style.opacity = '1';
      setTimeout(() => { saveStatus.style.opacity = '0'; }, 1500);
    });
  });

  // ── Status polling ─────────────────────────────────────────────

  function updateStatus() {
    chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
      if (chrome.runtime.lastError) { return; }

      if (response && response.connected) {
        statusEl.className       = 'status connected';
        statusText.textContent   = 'Connected to VS Code';
        reconnectBtn.style.display  = 'none';
        disconnectBtn.style.display = 'block';
      } else {
        statusEl.className       = 'status disconnected';
        const attempts = response ? response.reconnectAttempts : 0;
        const max      = response ? response.maxReconnectAttempts : 10;
        statusText.textContent = attempts >= max
          ? 'Disconnected (max retries)'
          : `Disconnected${attempts > 0 ? ` (retry ${attempts}/${max})` : ''}`;
        reconnectBtn.style.display  = 'block';
        disconnectBtn.style.display = 'none';
      }
    });
  }

  // ── Buttons ────────────────────────────────────────────────────

  reconnectBtn.addEventListener('click', () => {
    reconnectBtn.textContent = 'Connecting...';
    reconnectBtn.disabled    = true;
    chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
      setTimeout(() => {
        reconnectBtn.textContent = 'Reconnect';
        reconnectBtn.disabled    = false;
        updateStatus();
      }, 1500);
    });
  });

  disconnectBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'disconnect' }, () => { updateStatus(); });
  });

// ── Init ───────────────────────────────────────────────────────

  updateStatus();
  setInterval(updateStatus, 3000);
});
