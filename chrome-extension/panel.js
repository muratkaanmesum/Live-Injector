// DevTools panel — Live Injector
(function () {
  'use strict';

  const originEl = document.getElementById('origin');
  const emptyEl  = document.getElementById('empty');
  const tableEl  = document.getElementById('tags');
  const rowsEl   = document.getElementById('rows');

  let currentOrigin = null;
  let breakSet = new Set();
  const counts = new Map();
  const rowEls = new Map();

  // ── Origin resolution ────────────────────────────────────────────

  function setOrigin(origin) {
    currentOrigin = origin && origin !== 'null' ? origin : null;
    originEl.textContent = currentOrigin || 'no origin';
    readBreakSetFromStorage();
  }

  function resolveOrigin() {
    if (!chrome.devtools || !chrome.devtools.inspectedWindow) {
      setOrigin(null);
      return;
    }
    chrome.devtools.inspectedWindow.eval('location.origin', (result, err) => {
      if (err) { setOrigin(null); return; }
      setOrigin(result);
    });
  }

  // ── Break-set storage ────────────────────────────────────────────

  function readBreakSetFromStorage() {
    chrome.storage.local.get(['liBreakTags'], (res) => {
      const map = res.liBreakTags || {};
      const list = (currentOrigin && map[currentOrigin]) || [];
      breakSet = new Set(list);
      rowEls.forEach((_row, tag) => upsertRow(tag));
    });
  }

  function writeBreakSetToStorage() {
    if (!currentOrigin) return;
    chrome.storage.local.get(['liBreakTags'], (res) => {
      const map = res.liBreakTags || {};
      map[currentOrigin] = Array.from(breakSet);
      chrome.storage.local.set({ liBreakTags: map }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[panel] failed to persist break set:', chrome.runtime.lastError.message);
        }
      });
    });
  }

  // ── Rendering ────────────────────────────────────────────────────

  function render() {
    if (counts.size === 0) {
      emptyEl.classList.remove('hidden');
      tableEl.classList.add('hidden');
    } else {
      emptyEl.classList.add('hidden');
      tableEl.classList.remove('hidden');
    }
  }

  function upsertRow(tag) {
    let row = rowEls.get(tag);
    if (!row) {
      row = document.createElement('tr');
      const tagCell    = document.createElement('td');
      const countCell  = document.createElement('td');
      const toggleCell = document.createElement('td');
      const toggleInput = document.createElement('input');

      toggleInput.type = 'checkbox';
      toggleInput.addEventListener('change', () => {
        if (toggleInput.checked) breakSet.add(tag);
        else breakSet.delete(tag);
        writeBreakSetToStorage();
      });

      tagCell.textContent  = tag;
      countCell.className  = 'count';
      toggleCell.className = 'toggle';
      toggleCell.appendChild(toggleInput);
      row.appendChild(tagCell);
      row.appendChild(countCell);
      row.appendChild(toggleCell);
      rowsEl.appendChild(row);
      rowEls.set(tag, row);
    }
    row.children[1].textContent = String(counts.get(tag) || 0);
    const input = row.children[2].firstChild;
    input.checked  = breakSet.has(tag);
    input.disabled = currentOrigin === null;
  }

  function handleTagSeen(tag) {
    counts.set(tag, (counts.get(tag) || 0) + 1);
    upsertRow(tag);
    render();
  }

  function clearTags() {
    counts.clear();
    rowEls.clear();
    rowsEl.textContent = '';
    render();
  }

  // ── Event wiring ─────────────────────────────────────────────────

  const inspectedTabId = chrome.devtools && chrome.devtools.inspectedWindow
    ? chrome.devtools.inspectedWindow.tabId
    : null;

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'li-tag-seen' || !msg.tag) return;
    if (inspectedTabId != null && sender.tab && sender.tab.id !== inspectedTabId) return;
    handleTagSeen(msg.tag);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('liBreakTags' in changes)) return;
    readBreakSetFromStorage();
  });

  if (chrome.devtools && chrome.devtools.network) {
    chrome.devtools.network.onNavigated.addListener(() => {
      clearTags();
      resolveOrigin();
    });
  }

  // ── Init ─────────────────────────────────────────────────────────

  resolveOrigin();

})();
