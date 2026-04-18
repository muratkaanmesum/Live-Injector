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

  // ── Load saved values ──────────────────────────────────────────

  chrome.storage.local.get(
    ['preamble', 'clearEvents'],
    ({ preamble = '', clearEvents = false }) => {
      preambleTA.value          = preamble;
      clearEventsToggle.checked = clearEvents;
    }
  );

  // ── Clear Events toggle ────────────────────────────────────────

  clearEventsToggle.addEventListener('change', () => {
    chrome.storage.local.set({ clearEvents: clearEventsToggle.checked });
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
        statusEl.className       = 'status-bar connected';
        statusText.textContent   = 'Connected to VS Code';
        reconnectBtn.style.display  = 'none';
        disconnectBtn.style.display = 'block';
      } else {
        statusEl.className       = 'status-bar disconnected';
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
