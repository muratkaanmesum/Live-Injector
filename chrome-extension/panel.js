// DevTools panel — Live Injector
(function () {
  'use strict';

  const originChipEl  = document.getElementById('origin-chip');
  const originProtoEl = document.getElementById('origin-proto');
  const originEl      = document.getElementById('origin');
  const emptyEl       = document.getElementById('empty');
  const tableEl       = document.getElementById('tags');
  const rowsEl        = document.getElementById('rows');

  let currentOrigin = null;
  let breakSet = new Set();
  const counts = new Map();
  const rowEls = new Map();
  const groups = new Map(); // base → { headerEl, nameCell, countCell, instanceEls, expanded, total }
  let storedBreakMap = {};
  let localWriteInFlight = false;

  function parseBase(tag) {
    const m = tag.match(/^(.*)-\d+$/);
    return m ? m[1] : tag;
  }

  function getOrCreateGroup(base) {
    if (groups.has(base)) return groups.get(base);

    const headerEl  = document.createElement('tr');
    const nameCell  = document.createElement('td');
    const countCell = document.createElement('td');
    const emptyCell = document.createElement('td');

    headerEl.className  = 'group-header';
    nameCell.textContent = '▶ ' + base;
    countCell.className  = 'count';
    countCell.textContent = '0';

    headerEl.appendChild(nameCell);
    headerEl.appendChild(countCell);
    headerEl.appendChild(emptyCell);
    rowsEl.appendChild(headerEl);

    const group = { headerEl, nameCell, countCell, instanceEls: [], expanded: false, total: 0 };

    headerEl.addEventListener('click', () => {
      group.expanded = !group.expanded;
      nameCell.textContent = (group.expanded ? '▼ ' : '▶ ') + base;
      group.instanceEls.forEach(el => { el.style.display = group.expanded ? '' : 'none'; });
    });

    groups.set(base, group);
    return group;
  }

  // ── Origin resolution ────────────────────────────────────────────

  function setOrigin(origin) {
    currentOrigin = origin && origin !== 'null' ? origin : null;
    if (currentOrigin) {
      try {
        const url = new URL(currentOrigin);
        originProtoEl.textContent = url.protocol + '//';
        originEl.textContent = url.host;
      } catch {
        originProtoEl.textContent = '';
        originEl.textContent = currentOrigin;
      }
      originChipEl.classList.remove('is-unknown');
    } else {
      originProtoEl.textContent = '';
      originEl.textContent = 'no origin';
      originChipEl.classList.add('is-unknown');
    }
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
      storedBreakMap = map;
      const list = (currentOrigin && map[currentOrigin]) || [];
      breakSet = new Set(list);
      rowEls.forEach((_row, tag) => upsertRow(tag));
    });
  }

  function writeBreakSetToStorage() {
    if (!currentOrigin) return;
    storedBreakMap[currentOrigin] = Array.from(breakSet);
    localWriteInFlight = true;
    chrome.storage.local.set({ liBreakTags: storedBreakMap }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[panel] failed to persist break set:', chrome.runtime.lastError.message);
      }
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
    const base  = parseBase(tag);
    const group = getOrCreateGroup(base);

    let row = rowEls.get(tag);
    if (!row) {
      row = document.createElement('tr');
      const tagCell     = document.createElement('td');
      const countCell   = document.createElement('td');
      const toggleCell  = document.createElement('td');
      const toggleInput = document.createElement('input');

      toggleInput.type = 'checkbox';
      toggleInput.addEventListener('change', () => {
        if (toggleInput.checked) {
          breakSet.add(tag);
          if (!group.expanded) {
            group.expanded = true;
            group.nameCell.textContent = '▼ ' + base;
            group.instanceEls.forEach(el => { el.style.display = ''; });
          }
        } else {
          breakSet.delete(tag);
        }
        writeBreakSetToStorage();
      });

      tagCell.textContent  = tag;
      tagCell.className    = 'instance-tag';
      countCell.className  = 'count';
      toggleCell.className = 'toggle';
      toggleCell.appendChild(toggleInput);
      row.appendChild(tagCell);
      row.appendChild(countCell);
      row.appendChild(toggleCell);
      row.style.display = 'none';

      const anchor = group.instanceEls[group.instanceEls.length - 1] || group.headerEl;
      anchor.after(row);

      row._countCell   = countCell;
      row._toggleInput = toggleInput;
      group.instanceEls.push(row);
      rowEls.set(tag, row);

      if (breakSet.has(tag) && !group.expanded) {
        group.expanded = true;
        group.nameCell.textContent = '▼ ' + base;
        group.instanceEls.forEach(el => { el.style.display = ''; });
      }
    }
    row._countCell.textContent = String(counts.get(tag) || 0);
    row._toggleInput.checked   = breakSet.has(tag);
  }

  function handleTagSeen(tag) {
    counts.set(tag, (counts.get(tag) || 0) + 1);
    upsertRow(tag);
    const group = groups.get(parseBase(tag));
    if (group) {
      group.total++;
      group.countCell.textContent = String(group.total);
    }
    render();
  }

  function clearTags() {
    counts.clear();
    rowEls.clear();
    groups.clear();
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
    if (!currentOrigin && msg.origin) setOrigin(msg.origin);
    handleTagSeen(msg.tag);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('liBreakTags' in changes)) return;
    if (localWriteInFlight) { localWriteInFlight = false; return; }
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
