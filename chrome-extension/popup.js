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

  const drawer = document.getElementById('drawer');
  const tabs   = Array.from(document.querySelectorAll('.tab-chip'));
  const panels = Array.from(document.querySelectorAll('.panel'));

  // ── Drawer / tab behavior ──────────────────────────────────────

  function setActiveTab(name) {
    // null / falsy → collapse drawer
    const hasActive = Boolean(name);

    tabs.forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    panels.forEach((p) => {
      p.classList.toggle('is-active', p.id === `panel-${name}`);
    });

    drawer.classList.toggle('is-open', hasActive);

    try { chrome.storage.local.set({ popupActiveTab: hasActive ? name : null }); } catch (_) {}
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      // Toggle: clicking the active tab collapses the drawer
      const currentlyActive = tab.classList.contains('is-active');
      setActiveTab(currentlyActive ? null : name);
    });
  });

  // ── Tab indicators (dot on settings/preamble when non-default) ──

  function updateIndicators({ preamble = '', clearEvents = false }) {
    const settingsTab = document.querySelector('.tab-chip[data-tab="settings"]');
    const preambleTab = document.querySelector('.tab-chip[data-tab="preamble"]');
    if (settingsTab) settingsTab.classList.toggle('has-indicator', !!clearEvents);
    if (preambleTab) preambleTab.classList.toggle('has-indicator', (preamble || '').trim().length > 0);
  }

  // ── Load saved values ──────────────────────────────────────────

  chrome.storage.local.get(
    ['preamble', 'clearEvents', 'popupActiveTab'],
    ({ preamble = '', clearEvents = false, popupActiveTab = null }) => {
      preambleTA.value          = preamble;
      clearEventsToggle.checked = clearEvents;
      updateIndicators({ preamble, clearEvents });
      // Restore last-open drawer; default to closed (compact)
      if (popupActiveTab) setActiveTab(popupActiveTab);
    }
  );

  // ── Clear Events toggle ────────────────────────────────────────

  clearEventsToggle.addEventListener('change', () => {
    const checked = clearEventsToggle.checked;
    chrome.storage.local.set({ clearEvents: checked });
    updateIndicators({ preamble: preambleTA.value, clearEvents: checked });
  });

  // ── Save preamble ──────────────────────────────────────────────

  savePreamble.addEventListener('click', () => {
    chrome.storage.local.set({ preamble: preambleTA.value }, () => {
      if (chrome.runtime.lastError) { return; }
      saveStatus.style.opacity = '1';
      setTimeout(() => { saveStatus.style.opacity = '0'; }, 1500);
      updateIndicators({ preamble: preambleTA.value, clearEvents: clearEventsToggle.checked });
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
