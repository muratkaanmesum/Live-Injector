// DevTools panel — Live Injector
(function () {
  'use strict';

  const originChipEl  = document.getElementById('origin-chip');
  const originProtoEl = document.getElementById('origin-proto');
  const originEl      = document.getElementById('origin');
  const emptyEl       = document.getElementById('empty');
  const noResultsEl   = document.getElementById('no-results');
  const rowsEl        = document.getElementById('rows');

  let currentOrigin = null;
  let breakSet = new Set();
  const counts = new Map();
  const rowEls = new Map();
  // base → { groupEl, headerEl, bodyEl, nameCell, instCountCell, breakBadgeEl,
  //           hitCountCell, instanceEls, expanded, total }
  const groups = new Map();
  let storedBreakMap = {};
  let localWriteInFlight = false;
  let totalHits = 0;
  const hitLog = new Map(); // tag → number[] (timestamps of last 8 hits)

  // ── Sparkline helpers ────────────────────────────────────────────

  function recordHit(tag) {
    if (!hitLog.has(tag)) hitLog.set(tag, []);
    const log = hitLog.get(tag);
    log.push(Date.now());
    if (log.length > 8) log.shift();
  }

  function sparklineHeights(tag) {
    const log = hitLog.get(tag) || [];
    const now = Date.now();
    const heights = Array(8).fill(4);
    log.forEach((ts, i) => {
      const ageMs = now - ts;
      const h = Math.max(4, Math.round(92 - ageMs / 800));
      heights[8 - log.length + i] = Math.min(92, h);
    });
    return heights;
  }

  // ── Status bar ───────────────────────────────────────────────────

  const statusRulesEl  = document.getElementById('status-rules');
  const statusHitsEl   = document.getElementById('status-hits');
  const statusBreaksEl = document.getElementById('status-breaks');

  function updateStatusBar() {
    const ruleCount  = rowEls.size;
    const breakCount = breakSet.size;
    statusRulesEl.textContent  = ruleCount + (ruleCount === 1 ? ' rule' : ' rules');
    statusHitsEl.textContent   = totalHits + (totalHits === 1 ? ' hit' : ' hits');
    statusBreaksEl.textContent = breakCount + (breakCount === 1 ? ' break' : ' breaks');
    statusBreaksEl.classList.toggle('is-active', breakCount > 0);
  }

  // ── Filter state ─────────────────────────────────────────────────
  let filterMode  = 'all'; // 'all' | 'breaking' | 'hot'
  let searchQuery = '';
  let allExpanded = false;

  // ── Helpers ──────────────────────────────────────────────────────

  function parseBase(tag) {
    const m = tag.match(/^(.*)-\d+$/);
    return m ? m[1] : tag;
  }

  function svgCaret() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M9 6l6 6-6 6z');
    svg.appendChild(path);
    return svg;
  }

  function svgBulkBreak() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '11'); svg.setAttribute('height', '11');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '8');
    svg.appendChild(circle);
    return svg;
  }

  // ── Group card creation ──────────────────────────────────────────

  function getOrCreateGroup(base) {
    if (groups.has(base)) return groups.get(base);

    // card wrapper
    const groupEl   = document.createElement('div');
    groupEl.className = 'group';

    // header row
    const headerEl  = document.createElement('div');
    headerEl.className = 'group-row';

    const caretWrap = document.createElement('span');
    caretWrap.className = 'caret';
    caretWrap.appendChild(svgCaret());

    const nameCell  = document.createElement('span');
    nameCell.className = 'group-name';
    nameCell.textContent = base;

    const instCountCell = document.createElement('span');
    instCountCell.className = 'group-inst-count';
    instCountCell.textContent = '0 rules';

    const breakBadgeEl = document.createElement('span');
    breakBadgeEl.className = 'break-badge hidden';
    breakBadgeEl.textContent = '0';

    const hitCountCell = document.createElement('span');
    hitCountCell.className = 'group-hit-count';
    hitCountCell.textContent = '0';

    const bulkBreakBtn = document.createElement('button');
    bulkBreakBtn.className = 'bulk-break';
    bulkBreakBtn.title = 'Toggle breakpoints for all rules';
    bulkBreakBtn.appendChild(svgBulkBreak());

    headerEl.appendChild(caretWrap);
    headerEl.appendChild(nameCell);
    headerEl.appendChild(instCountCell);
    headerEl.appendChild(breakBadgeEl);
    headerEl.appendChild(hitCountCell);
    headerEl.appendChild(bulkBreakBtn);

    // body (instances)
    const bodyEl = document.createElement('div');
    bodyEl.className = 'group-body';

    const wrapEl = document.createElement('div');
    wrapEl.className = 'group-body-wrap';
    wrapEl.appendChild(bodyEl);

    groupEl.appendChild(headerEl);
    groupEl.appendChild(wrapEl);
    rowsEl.appendChild(groupEl);

    const group = {
      groupEl, headerEl, bodyEl, nameCell, instCountCell,
      breakBadgeEl, hitCountCell, instanceEls: [], expanded: false, total: 0,
    };

    headerEl.addEventListener('click', (e) => {
      if (e.target.closest('.bulk-break')) return;
      group.expanded = !group.expanded;
      groupEl.classList.toggle('is-open', group.expanded);
    });

    bulkBreakBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const anyBreaking = group.instanceEls.some(row => breakSet.has(row._tag));
      group.instanceEls.forEach(row => {
        if (anyBreaking) breakSet.delete(row._tag);
        else             breakSet.add(row._tag);
      });
      if (!anyBreaking && !group.expanded) {
        group.expanded = true;
        groupEl.classList.add('is-open');
      }
      writeBreakSetToStorage();
      group.instanceEls.forEach(row => syncInstanceRow(row));
      updateGroupBreakBadge(group);
      applyFilter();
      updateStatusBar();
    });

    groups.set(base, group);
    return group;
  }

  // ── Instance row helpers ─────────────────────────────────────────

  function syncInstanceRow(row) {
    row._countCell.textContent = String(counts.get(row._tag) || 0);
    row._toggleInput.checked   = breakSet.has(row._tag);
    row.classList.toggle('is-breaking', breakSet.has(row._tag));
    const heights = sparklineHeights(row._tag);
    row._sparkBars.forEach((bar, i) => { bar.style.height = heights[i] + '%'; });
  }

  function updateGroupBreakBadge(group) {
    const count = group.instanceEls.filter(row => breakSet.has(row._tag)).length;
    group.breakBadgeEl.textContent = String(count);
    group.breakBadgeEl.classList.toggle('hidden', count === 0);
    group.groupEl.classList.toggle('has-breaks', count > 0);
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
      groups.forEach(group => updateGroupBreakBadge(group));
      applyFilter();
      updateStatusBar();
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

  // ── Filter ───────────────────────────────────────────────────────

  function applyFilter() {
    const q = searchQuery.toLowerCase();

    let hotThreshold = 0;
    if (filterMode === 'hot' && counts.size > 0) {
      const vals = Array.from(counts.values()).sort((a, b) => b - a);
      hotThreshold = vals[Math.max(0, Math.ceil(vals.length * 0.25) - 1)] || 1;
    }

    let anyGroupVisible = false;
    groups.forEach((group, base) => {
      let anyInstanceVisible = false;
      group.instanceEls.forEach(row => {
        const tag   = row._tag;
        const count = counts.get(tag) || 0;
        const matchesSearch = !q || tag.toLowerCase().includes(q) || base.toLowerCase().includes(q);
        const matchesMode   = filterMode === 'all'
          || (filterMode === 'breaking' && breakSet.has(tag))
          || (filterMode === 'hot'      && count >= hotThreshold);
        const visible = matchesSearch && matchesMode;
        row.classList.toggle('hidden', !visible);
        if (visible) anyInstanceVisible = true;
      });
      group.groupEl.classList.toggle('hidden', !anyInstanceVisible);
      if (anyInstanceVisible) anyGroupVisible = true;
    });

    const hasFilterActive = filterMode !== 'all' || searchQuery !== '';
    noResultsEl.classList.toggle('hidden', !hasFilterActive || anyGroupVisible || counts.size === 0);
  }

  // ── Rendering ────────────────────────────────────────────────────

  function render() {
    if (counts.size === 0) {
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      applyFilter();
    }
  }

  function upsertRow(tag) {
    const base  = parseBase(tag);
    const group = getOrCreateGroup(base);

    let row = rowEls.get(tag);
    if (!row) {
      row = document.createElement('div');
      row.className = 'instance';

      const dotEl       = document.createElement('span');
      const nameEl      = document.createElement('span');
      const countCell   = document.createElement('span');
      const toggleInput = document.createElement('input');

      dotEl.className       = 'instance-dot';
      nameEl.className      = 'instance-name';
      nameEl.textContent    = tag;
      countCell.className   = 'instance-hit-count';
      toggleInput.type      = 'checkbox';
      toggleInput.className = 'bp';

      const sparklineEl = document.createElement('div');
      sparklineEl.className = 'sparkline';
      const sparkBars = Array.from({ length: 8 }, () => {
        const bar = document.createElement('span');
        bar.style.height = '4%';
        sparklineEl.appendChild(bar);
        return bar;
      });

      toggleInput.addEventListener('change', () => {
        if (toggleInput.checked) {
          breakSet.add(tag);
          if (!group.expanded) {
            group.expanded = true;
            group.groupEl.classList.add('is-open');
          }
        } else {
          breakSet.delete(tag);
        }
        syncInstanceRow(row);
        updateGroupBreakBadge(group);
        writeBreakSetToStorage();
        applyFilter();
        updateStatusBar();
      });

      row.appendChild(dotEl);
      row.appendChild(nameEl);
      row.appendChild(sparklineEl);
      row.appendChild(countCell);
      row.appendChild(toggleInput);
      group.bodyEl.appendChild(row);

      row.tabIndex     = 0;
      row._tag         = tag;
      row._countCell   = countCell;
      row._toggleInput = toggleInput;
      row._sparkBars   = sparkBars;
      group.instanceEls.push(row);

      // update instance count label
      group.instCountCell.textContent = group.instanceEls.length + ' rule' +
        (group.instanceEls.length !== 1 ? 's' : '');

      if (breakSet.has(tag) && !group.expanded) {
        group.expanded = true;
        group.groupEl.classList.add('is-open');
      }
    }
    syncInstanceRow(row);
  }

  function handleTagSeen(tag) {
    counts.set(tag, (counts.get(tag) || 0) + 1);
    totalHits++;
    recordHit(tag);
    upsertRow(tag);
    // Pulse the count cell
    const row = rowEls.get(tag);
    if (row) {
      row._countCell.classList.remove('pulse');
      void row._countCell.offsetWidth; // force reflow to restart animation
      row._countCell.classList.add('pulse');
    }
    const group = groups.get(parseBase(tag));
    if (group) {
      group.total++;
      group.hitCountCell.textContent = String(group.total);
    }
    render();
    updateStatusBar();
  }

  function clearTags() {
    counts.clear();
    rowEls.clear();
    groups.clear();
    hitLog.clear();
    rowsEl.textContent = '';
    totalHits = 0;
    render();
    updateStatusBar();
  }

  // ── Toolbar wiring ───────────────────────────────────────────────

  const searchInput    = document.getElementById('search-input');
  const filterSeg      = document.getElementById('filter-seg');
  const collapseAllBtn = document.getElementById('collapse-all-btn');
  const clearBreaksBtn = document.getElementById('clear-breaks-btn');

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      applyFilter();
    }, 80);
  });

  filterSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    filterMode = btn.dataset.filter;
    filterSeg.querySelectorAll('button').forEach(b => b.classList.toggle('is-active', b === btn));
    applyFilter();
  });

  collapseAllBtn.addEventListener('click', () => {
    allExpanded = !allExpanded;
    groups.forEach(group => {
      group.expanded = allExpanded;
      group.groupEl.classList.toggle('is-open', allExpanded);
    });
    applyFilter();
  });

  clearBreaksBtn.addEventListener('click', () => {
    breakSet.clear();
    writeBreakSetToStorage();
    rowEls.forEach((_row, tag) => upsertRow(tag));
    groups.forEach(group => updateGroupBreakBadge(group));
    applyFilter();
    updateStatusBar();
  });

  // ── Keyboard shortcuts ───────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    const active  = document.activeElement;
    const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');

    // ⌘F / Ctrl+F — focus search
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }

    // ⌘K / Ctrl+K — clear all breaks
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      clearBreaksBtn.click();
      return;
    }

    if (inInput) return;

    // Space — toggle break on focused instance row
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (active && active.classList.contains('instance') && active._toggleInput) {
        e.preventDefault();
        active._toggleInput.click();
        return;
      }
    }

    // ↑ / ↓ — navigate visible rows within open groups
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const allRows = Array.from(rowsEl.querySelectorAll('.group.is-open .instance:not(.hidden)'));
      if (allRows.length === 0) return;
      const currentIdx = allRows.indexOf(active);
      let nextIdx;
      if (e.key === 'ArrowDown') {
        nextIdx = currentIdx === -1 ? 0 : Math.min(currentIdx + 1, allRows.length - 1);
      } else {
        nextIdx = currentIdx === -1 ? allRows.length - 1 : Math.max(currentIdx - 1, 0);
      }
      allRows[nextIdx].focus();
      return;
    }

    // Escape — blur focused element
    if (e.key === 'Escape' && active && active !== document.body) {
      active.blur();
    }
  });

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
