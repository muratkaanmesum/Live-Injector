// DevTools panel — Live Injector
(function () {
  'use strict';

  const originChipEl  = document.getElementById('origin-chip');
  const originProtoEl = document.getElementById('origin-proto');
  const originEl      = document.getElementById('origin');
  const emptyEl       = document.getElementById('empty');
  const noResultsEl   = document.getElementById('no-results');
  const rowsEl        = document.getElementById('rows');
  const toastEl         = document.getElementById('toast');
  const toastMsgEl      = toastEl && toastEl.querySelector('.toast-msg');
  const toastIconError  = document.getElementById('toast-icon-error');
  const toastIconInfo   = document.getElementById('toast-icon-info');
  let   toastTimer      = 0;

  let currentOrigin = null;
  let breakSet = new Set();
  const counts = new Map();
  const outcomes = new Map(); // tag -> { outcome: 'pass'|'fail'|'error', at: number, message: string|null }
  const rowEls = new Map();
  // builderId → { groupEl, headerEl, bodyEl, nameCell, metaEl, breakBadgeEl,
  //               hitCountCell, instanceEls, expanded, campaignCount, ruleCount, builderId }
  const groups = new Map();
  let storedBreakMap = {};
  let localWriteInFlight = false;
  let totalHits = 0;
  const hitLog = new Map(); // tag → number[] (timestamps of last 8 hits)

  function showToast(message, type /* 'error' | 'info' */) {
    if (!toastEl || !toastMsgEl) return;
    if (type !== 'error' && type !== 'info') type = 'info';

    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = 0;
    }

    toastMsgEl.textContent = String(message == null ? '' : message);
    toastEl.dataset.type = type;

    if (toastIconError) toastIconError.style.display = (type === 'error') ? '' : 'none';
    if (toastIconInfo)  toastIconInfo.style.display  = (type === 'info')  ? '' : 'none';

    toastEl.classList.add('is-visible');

    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
      toastTimer = 0;
    }, 1800);
  }

  // New state for builder-keyed grouping
  const builderMetaCache    = new Map(); // builderId → {builderId, variationId}
  const varIdToBuilder      = new Map(); // variationId (string) → builderId (string)
  const resolvingVarIds     = new Set(); // variationId strings with active resolveBuilderMeta
  const resolvingBuilderIds = new Set(); // builderId strings with active resolveBuilderMeta

  // Pending group singleton (tags awaiting Insider runtime resolution)
  let pendingGroup = null;

  // Testing variation state
  let testingVariationId = null;
  let testingPollTimer   = null;

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

  // Campaign tags are just Campaign-<variationId> (variationId is stable, so
  // re-evals land on the same row). Custom-Rule tags carry a ruleId suffix
  // (Custom-Rule-<builderId>-<ruleId>) — same rule fired on re-init collapses
  // onto its existing row, different rules under the same campaign stay apart.
  function parseTag(tag) {
    const m = tag.match(/^(Campaign|Custom-Rule)-(\d+)(?:-\d+)?$/);
    if (!m) return null;
    return { type: m[1], id: m[2] };
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

  // ── evalOnPage helper ────────────────────────────────────────────

  function evalOnPage(expr) {
    return new Promise((resolve) => {
      if (!chrome.devtools || !chrome.devtools.inspectedWindow) { resolve(null); return; }
      try {
        chrome.devtools.inspectedWindow.eval(expr, (result, err) => {
          resolve((err || result == null) ? null : result);
        });
      } catch (_) { resolve(null); }
    });
  }

  // ── Builder meta resolution ──────────────────────────────────────

  async function resolveBuilderMeta(parsed) {
    if (!parsed) return null;
    const { type, id } = parsed;
    try {
      let builderId, variationId;
      if (type === 'Campaign') {
        variationId = id;
        if (varIdToBuilder.has(variationId)) {
          builderId = varIdToBuilder.get(variationId);
          return builderMetaCache.get(builderId) || null;
        }
        const raw = await evalOnPage(
          `(function(){try{var r=Insider.campaign.getBuilderIdByVariationId(${variationId});return r!=null?String(r):null;}catch(e){return null;}})()`
        );
        builderId = raw;
      } else {
        builderId = id;
        if (builderMetaCache.has(builderId)) return builderMetaCache.get(builderId);
        const raw = await evalOnPage(
          `(function(){try{var r=Insider.campaign.userSegment.getActiveVariationByBuilderId(${builderId});return r!=null?String(r):null;}catch(e){return null;}})()`
        );
        variationId = raw;
      }
      if (!builderId) return null;

      const meta = {
        builderId: String(builderId),
        variationId: variationId ? String(variationId) : null,
      };
      builderMetaCache.set(String(builderId), meta);
      if (variationId) varIdToBuilder.set(String(variationId), String(builderId));
      return meta;
    } catch (_) {
      return null;
    }
  }

  // ── Testing variation poller ─────────────────────────────────────

  async function pollTestingVariation() {
    const expr = `(function(){try{
      if(!window.Insider||!Insider.dom)return null;
      var v=Insider.dom('.inspector-variation-list>option:selected').attr('value');
      return v?String(v):null;
    }catch(e){return null;}})()`;
    const next = await evalOnPage(expr);
    const normalized = next || null;
    if (normalized === testingVariationId) return;
    applyTestingVariation(normalized);
  }

  function applyTestingVariation(nextId) {
    if (testingVariationId) {
      const prevBid = varIdToBuilder.get(testingVariationId);
      const prevGroup = prevBid && groups.get(prevBid);
      if (prevGroup) prevGroup.groupEl.classList.remove('is-testing');
    }
    testingVariationId = nextId;
    if (!nextId) return;
    const bid = varIdToBuilder.get(nextId);
    const g = bid && groups.get(bid);
    if (g) g.groupEl.classList.add('is-testing');
  }

  // ── Group meta subtitle helper ───────────────────────────────────

  function updateGroupMeta(group) {
    if (!group || !group.metaEl) return;
    group.metaEl.textContent =
      group.campaignCount + (group.campaignCount === 1 ? ' CAMPAIGN' : ' CAMPAIGNS') +
      ' · ' + group.ruleCount + (group.ruleCount === 1 ? ' RULE' : ' RULES');
  }

  function updateGroupVariationId(builderId, variationId) {
    const group = groups.get(String(builderId));
    if (group && group.varCell && variationId && !group._variationId) {
      group.varCell.textContent = 'variationId: ' + variationId;
      group._variationId = variationId;
    }
  }

  // ── Group hit count helper ───────────────────────────────────────

  function updateGroupHitCount(group) {
    if (!group) return;
    const total = group.instanceEls.reduce((s, r) => s + (counts.get(r._tag) || 0), 0);
    group.hitCountCell.textContent = String(total);
  }

  // ── Group card creation ──────────────────────────────────────────

  function getOrCreateGroup(builderId, variationId) {
    const key = String(builderId);
    if (groups.has(key)) {
      const existing = groups.get(key);
      if (variationId && !existing._variationId) {
        existing.varCell.textContent = 'variationId: ' + variationId;
        existing._variationId = variationId;
      }
      return existing;
    }

    // card wrapper
    const groupEl = document.createElement('div');
    groupEl.className = 'group';

    // .group-header — outer click target wrapper
    const groupHeaderEl = document.createElement('div');
    groupHeaderEl.className = 'group-header';

    // .group-row — inner grid (caret, name, break-badge, hit-count, bulk-break — 5 cols)
    const headerEl = document.createElement('div');
    headerEl.className = 'group-row';

    const caretWrap = document.createElement('span');
    caretWrap.className = 'caret';
    caretWrap.appendChild(svgCaret());

    const nameCell = document.createElement('span');
    nameCell.className = 'group-name';

    const builderIdSpan = document.createElement('span');
    builderIdSpan.className = 'group-name-id';
    builderIdSpan.textContent = 'BuilderID: ' + key;

    const varCell = document.createElement('span');
    varCell.className = 'group-variation-id';
    varCell.textContent = variationId ? 'variationId: ' + variationId : '—';

    const sepSpan = document.createElement('span');
    sepSpan.className = 'group-name-sep';
    sepSpan.textContent = '|';

    const testingPill = document.createElement('span');
    testingPill.className = 'testing-pill';
    testingPill.textContent = 'live';

    nameCell.appendChild(builderIdSpan);
    nameCell.appendChild(sepSpan);
    nameCell.appendChild(varCell);
    nameCell.appendChild(testingPill);

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
    headerEl.appendChild(breakBadgeEl);
    headerEl.appendChild(hitCountCell);
    headerEl.appendChild(bulkBreakBtn);

    // .group-meta — subtitle line
    const metaEl = document.createElement('div');
    metaEl.className = 'group-meta';
    metaEl.textContent = '0 CAMPAIGNS · 0 RULES';

    groupHeaderEl.appendChild(headerEl);
    groupHeaderEl.appendChild(metaEl);

    // body (instances)
    const bodyEl = document.createElement('div');
    bodyEl.className = 'group-body';

    const wrapEl = document.createElement('div');
    wrapEl.className = 'group-body-wrap';
    wrapEl.appendChild(bodyEl);

    groupEl.appendChild(groupHeaderEl);
    groupEl.appendChild(wrapEl);
    rowsEl.appendChild(groupEl);

    const group = {
      groupEl, headerEl: groupHeaderEl, bodyEl, nameCell, varCell, metaEl,
      breakBadgeEl, hitCountCell, instanceEls: [], expanded: false,
      builderId: key, campaignCount: 0, ruleCount: 0,
      _variationId: variationId ? String(variationId) : null,
    };

    groupHeaderEl.addEventListener('click', (e) => {
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

    groups.set(key, group);

    if (testingVariationId && varIdToBuilder.get(testingVariationId) === key) {
      groupEl.classList.add('is-testing');
    }

    return group;
  }

  // ── Pending group ────────────────────────────────────────────────

  function getOrCreatePendingGroup() {
    if (pendingGroup) return pendingGroup;

    const groupEl = document.createElement('div');
    groupEl.className = 'group is-pending';

    const groupHeaderEl = document.createElement('div');
    groupHeaderEl.className = 'group-header';

    const headerEl = document.createElement('div');
    headerEl.className = 'group-row';

    const caretWrap = document.createElement('span');
    caretWrap.className = 'caret';
    caretWrap.appendChild(svgCaret());

    const nameCell = document.createElement('span');
    nameCell.className = 'group-name';
    nameCell.textContent = 'Awaiting Insider Runtime';

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
    headerEl.appendChild(breakBadgeEl);
    headerEl.appendChild(hitCountCell);
    headerEl.appendChild(bulkBreakBtn);

    groupHeaderEl.appendChild(headerEl);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'group-body';

    const wrapEl = document.createElement('div');
    wrapEl.className = 'group-body-wrap';
    wrapEl.appendChild(bodyEl);

    groupEl.appendChild(groupHeaderEl);
    groupEl.appendChild(wrapEl);

    // Insert as first child of rowsEl
    rowsEl.insertBefore(groupEl, rowsEl.firstChild);

    pendingGroup = {
      groupEl, headerEl: groupHeaderEl, bodyEl, nameCell,
      metaEl: null,
      breakBadgeEl, hitCountCell, instanceEls: [], expanded: true,
      builderId: null, campaignCount: 0, ruleCount: 0,
    };

    // Pending group is always open
    groupEl.classList.add('is-open');

    groupHeaderEl.addEventListener('click', (e) => {
      if (e.target.closest('.bulk-break')) return;
      // Pending group doesn't collapse
    });

    bulkBreakBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const anyBreaking = pendingGroup.instanceEls.some(row => breakSet.has(row._tag));
      pendingGroup.instanceEls.forEach(row => {
        if (anyBreaking) breakSet.delete(row._tag);
        else             breakSet.add(row._tag);
      });
      writeBreakSetToStorage();
      pendingGroup.instanceEls.forEach(row => syncInstanceRow(row));
      updateGroupBreakBadge(pendingGroup);
      applyFilter();
      updateStatusBar();
    });

    return pendingGroup;
  }

  function removePendingGroupIfEmpty() {
    if (pendingGroup && pendingGroup.instanceEls.length === 0) {
      pendingGroup.groupEl.remove();
      pendingGroup = null;
    }
  }

  // ── Instance row helpers ─────────────────────────────────────────

  function syncInstanceRow(row) {
    row._countCell.textContent = String(counts.get(row._tag) || 0);
    row._toggleInput.checked   = breakSet.has(row._tag);
    row.classList.toggle('is-breaking', breakSet.has(row._tag));
    const heights = sparklineHeights(row._tag);
    row._sparkBars.forEach((bar, i) => { bar.style.height = heights[i] + '%'; });

    syncSourceBtn(row);

    const el = row._outcomeEl;
    if (!el) return;
    el.classList.remove('is-pass', 'is-fail', 'is-error');
    const o = outcomes.get(row._tag);
    if (!o) {
      el.textContent = '';
      el.removeAttribute('title');
      return;
    }
    const when = new Date(o.at).toTimeString().slice(0, 8);
    if (o.outcome === 'pass') {
      el.textContent = '✓';
      el.classList.add('is-pass');
      el.title = `Last outcome: passed (${when})`;
    } else if (o.outcome === 'fail') {
      el.textContent = '✗';
      el.classList.add('is-fail');
      el.title = `Last outcome: failed (${when})`;
    } else {
      el.textContent = '⚠';
      el.classList.add('is-error');
      el.title = `Last outcome: errored: ${o.message || ''} (${when})`;
    }
  }

  function updateGroupBreakBadge(group) {
    if (!group) return;
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
      rowEls.forEach((row) => syncInstanceRow(row));
      groups.forEach(group => updateGroupBreakBadge(group));
      if (pendingGroup) updateGroupBreakBadge(pendingGroup);
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
        const matchesSearch = !q
          || tag.toLowerCase().includes(q)
          || String(base).toLowerCase().includes(q)
          || (group.nameCell && group.nameCell.textContent.toLowerCase().includes(q));
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

    // Also handle pending group rows
    if (pendingGroup) {
      let anyVisible = false;
      pendingGroup.instanceEls.forEach(row => {
        const tag   = row._tag;
        const count = counts.get(tag) || 0;
        const matchesSearch = !q
          || tag.toLowerCase().includes(q)
          || (pendingGroup.nameCell && pendingGroup.nameCell.textContent.toLowerCase().includes(q));
        const matchesMode = filterMode === 'all'
          || (filterMode === 'breaking' && breakSet.has(tag))
          || (filterMode === 'hot'      && count >= hotThreshold);
        const visible = matchesSearch && matchesMode;
        row.classList.toggle('hidden', !visible);
        if (visible) anyVisible = true;
      });
      pendingGroup.groupEl.classList.toggle('hidden', !anyVisible);
      if (anyVisible) anyGroupVisible = true;
    }

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

  function upsertRow(tag, group) {
    const parsed = parseTag(tag);

    let row = rowEls.get(tag);
    if (!row) {
      row = document.createElement('div');
      row.className = 'instance';

      const dotEl     = document.createElement('span');
      dotEl.className = 'instance-dot';

      // Type badge (column 2)
      const badge = document.createElement('div');
      badge.className = 'row-badge';
      if (parsed) {
        badge.classList.add(parsed.type === 'Campaign' ? 'type-campaign' : 'type-rule');
        badge.textContent = parsed.type === 'Campaign' ? 'Campaign' : 'Rule';
      } else {
        badge.classList.add('type-rule');
        badge.textContent = 'Tag';
      }

      const sparklineEl = document.createElement('div');
      sparklineEl.className = 'sparkline';
      const sparkBars = Array.from({ length: 8 }, () => {
        const bar = document.createElement('span');
        bar.style.height = '4%';
        sparklineEl.appendChild(bar);
        return bar;
      });

      const countCell   = document.createElement('span');
      countCell.className = 'instance-hit-count';

      const toggleInput = document.createElement('input');
      toggleInput.type      = 'checkbox';
      toggleInput.className = 'bp';

      toggleInput.addEventListener('change', () => {
        const currentGroup = row._group;
        if (toggleInput.checked) {
          breakSet.add(tag);
          if (currentGroup && currentGroup !== pendingGroup && !currentGroup.expanded) {
            currentGroup.expanded = true;
            currentGroup.groupEl.classList.add('is-open');
          }
        } else {
          breakSet.delete(tag);
        }
        syncInstanceRow(row);
        if (currentGroup) updateGroupBreakBadge(currentGroup);
        writeBreakSetToStorage();
        applyFilter();
        updateStatusBar();
      });

      const outcomeEl = document.createElement('span');
      outcomeEl.className = 'instance-outcome';
      if (!parsed || parsed.type !== 'Custom-Rule') {
        outcomeEl.classList.add('instance-outcome--hidden');
      }

      row.appendChild(dotEl);
      row.appendChild(outcomeEl);
      row.appendChild(badge);
      row.appendChild(sparklineEl);
      row.appendChild(toggleInput);

      // "src" button: only for rule rows known to have come from Insider.rules.call
      // (i.e. have a real rule id available). Clicking re-evals the test in-page
      // with a //# sourceURL comment so it shows up in DevTools Sources.
      const sourceBtn = document.createElement('button');
      sourceBtn.className = 'source-btn hidden';
      sourceBtn.type      = 'button';
      sourceBtn.textContent = 'rerun';
      sourceBtn.setAttribute('data-tip', 'Re-run this rule');
      sourceBtn.setAttribute(
        'data-tip-desc',
        'Re-evaluates the rule in-page with a //# sourceURL comment so it shows up under DevTools → Sources.'
      );
      sourceBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        annotateRuleFromRow(row);
      });
      row.appendChild(sourceBtn);
      row._sourceBtn = sourceBtn;

      group.bodyEl.appendChild(row);

      row.tabIndex     = 0;
      row.style.cursor = 'pointer';
      row.addEventListener('click', (e) => {
        if (e.target === toggleInput) return;
        chrome.devtools.inspectedWindow.getResources((resources) => {
          const match = resources.find(r => r.url.includes(tag));
          if (!match) {
            console.warn('[LiveInjector] no resource URL contains tag:', tag,
              '— known URLs:', resources.map(r => r.url));
            showToast("Source couldn't be found", 'error');
            return;
          }
          chrome.devtools.panels.openResource(match.url, 0, () => {
            const err = chrome.runtime && chrome.runtime.lastError;
            if (err) {
              console.warn('[LiveInjector] openResource failed for', match.url, '—', err.message);
              showToast("Source couldn't be found", 'error');
            }
          });
        });
      });
      row._tag         = tag;
      row._countCell   = countCell;
      row._outcomeEl   = outcomeEl;
      row._toggleInput = toggleInput;
      row._sparkBars   = sparkBars;
      row._badge       = badge;
      row._group       = group;

      group.instanceEls.push(row);

      // Update group type counts
      if (parsed && group !== pendingGroup) {
        if (parsed.type === 'Campaign') group.campaignCount++;
        else group.ruleCount++;
        updateGroupMeta(group);
      }

      // Expand group if this tag has a breakpoint (but not for pending group)
      if (breakSet.has(tag) && group !== pendingGroup && !group.expanded) {
        group.expanded = true;
        group.groupEl.classList.add('is-open');
      }

      rowEls.set(tag, row);
    }
    syncInstanceRow(row);
  }

  // ── Row migration (pending → real group) ─────────────────────────

  function migrateRow(tag, targetBuilderId, targetVariationId) {
    const row = rowEls.get(tag);
    if (!row || !pendingGroup) return;
    const srcGroup = pendingGroup;
    if (!srcGroup.instanceEls.includes(row)) return; // already migrated or not pending

    const targetGroup = getOrCreateGroup(targetBuilderId, targetVariationId);

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function doMove() {
      // Remove from pending
      const idx = srcGroup.instanceEls.indexOf(row);
      if (idx !== -1) srcGroup.instanceEls.splice(idx, 1);
      updateGroupHitCount(srcGroup);

      // Move DOM node
      targetGroup.bodyEl.appendChild(row);
      row._group = targetGroup;

      // Update target group counts
      const parsed = parseTag(tag);
      if (parsed && parsed.type === 'Campaign') targetGroup.campaignCount++;
      else if (parsed) targetGroup.ruleCount++;
      updateGroupMeta(targetGroup);
      targetGroup.instanceEls.push(row);
      updateGroupHitCount(targetGroup);

      // Update break-open state
      if (breakSet.has(tag) && !targetGroup.expanded) {
        targetGroup.expanded = true;
        targetGroup.groupEl.classList.add('is-open');
      }
      updateGroupBreakBadge(targetGroup);

      // Animate enter
      if (!prefersReduced) {
        row.style.animation = 'row-enter 180ms ease-out forwards';
        row.addEventListener('animationend', () => { row.style.animation = ''; }, { once: true });
        // Badge pulse
        if (row._badge) {
          row._badge.classList.add('just-arrived');
          setTimeout(() => row._badge.classList.remove('just-arrived'), 300);
        }
      }

      removePendingGroupIfEmpty();
      applyFilter();
      updateStatusBar();
    }

    if (prefersReduced) {
      doMove();
    } else {
      row.style.animation = 'row-exit 140ms ease-out forwards';
      setTimeout(doMove, 140);
    }
  }

  // ── Main event handler ───────────────────────────────────────────

  function handleTagSeen(tag) {
    counts.set(tag, (counts.get(tag) || 0) + 1);
    totalHits++;
    recordHit(tag);

    const parsed = parseTag(tag);

    if (parsed) {
      if (parsed.type === 'Campaign') {
        const alreadyResolved = varIdToBuilder.has(parsed.id);
        if (alreadyResolved) {
          const builderId = varIdToBuilder.get(parsed.id);
          const meta = builderMetaCache.get(builderId);
          const group = getOrCreateGroup(builderId, meta ? meta.variationId : null);
          if (!rowEls.has(tag)) upsertRow(tag, group);
          else syncInstanceRow(rowEls.get(tag));
          updateGroupHitCount(group);
        } else {
          // Put in pending immediately
          const pg = getOrCreatePendingGroup();
          if (!rowEls.has(tag)) upsertRow(tag, pg);
          else syncInstanceRow(rowEls.get(tag));
          updateGroupHitCount(pg);

          // Resolve async — fire and forget (deduped by variationId)
          if (!resolvingVarIds.has(parsed.id)) {
            resolvingVarIds.add(parsed.id);
            resolveBuilderMeta(parsed).then(meta => {
              resolvingVarIds.delete(parsed.id);
              if (!meta) {
                console.warn('[panel] could not resolve builderId for', tag);
                return;
              }
              migrateRow(tag, meta.builderId, meta.variationId);
            }).catch(() => { resolvingVarIds.delete(parsed.id); });
          }
        }
      } else {
        // Custom-Rule: builderId known immediately from tag
        const builderId = parsed.id;
        const cachedMeta = builderMetaCache.get(builderId);
        const group = getOrCreateGroup(builderId, cachedMeta ? cachedMeta.variationId : null);
        if (!rowEls.has(tag)) upsertRow(tag, group);
        else syncInstanceRow(rowEls.get(tag));
        updateGroupHitCount(group);

        // Resolve variationId async for group header display (deduped by builderId)
        if (!builderMetaCache.has(builderId) && !resolvingBuilderIds.has(builderId)) {
          resolvingBuilderIds.add(builderId);
          resolveBuilderMeta(parsed).then(resolvedMeta => {
            resolvingBuilderIds.delete(builderId);
            if (!resolvedMeta) return;
            updateGroupVariationId(builderId, resolvedMeta.variationId);
          }).catch(() => { resolvingBuilderIds.delete(builderId); });
        }
      }
    } else {
      // Unrecognized tag format — fallback to parseBase grouping
      const base = parseBase(tag);
      const group = getOrCreateGroup(base, null);
      if (!rowEls.has(tag)) upsertRow(tag, group);
      else syncInstanceRow(rowEls.get(tag));
      updateGroupHitCount(group);
    }

    // Pulse count cell
    const row = rowEls.get(tag);
    if (row) {
      row._countCell.classList.remove('pulse');
      void row._countCell.offsetWidth; // force reflow to restart animation
      row._countCell.classList.add('pulse');
    }

    render();
    updateStatusBar();
  }

  function clearTags() {
    counts.clear();
    rowEls.clear();
    groups.clear();
    builderMetaCache.clear();
    varIdToBuilder.clear();
    resolvingVarIds.clear();
    resolvingBuilderIds.clear();
    hitLog.clear();
    outcomes.clear();
    ruleIdByTag.clear();
    sourcedRuleIds.clear();
    evalSeenBuilders.clear();
    if (pendingGroup) {
      pendingGroup.groupEl.remove();
      pendingGroup = null;
    }
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
    // Skip pendingGroup — it's always open
    groups.forEach(group => {
      group.expanded = allExpanded;
      group.groupEl.classList.toggle('is-open', allExpanded);
    });
    applyFilter();
  });

  clearBreaksBtn.addEventListener('click', () => {
    breakSet.clear();
    writeBreakSetToStorage();
    rowEls.forEach((row) => syncInstanceRow(row));
    groups.forEach(group => updateGroupBreakBadge(group));
    if (pendingGroup) updateGroupBreakBadge(pendingGroup);
    applyFilter();
    updateStatusBar();
  });

  // ── Interceptor chip wiring ──────────────────────────────────────

  const evalInterceptBtn   = document.getElementById('eval-intercept-toggle');
  const scriptInterceptBtn = document.getElementById('script-intercept-toggle');
  const rulesInterceptBtn  = document.getElementById('rules-intercept-toggle');

  function setChipState(btn, active) {
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  chrome.storage.local.get(
    ['evalInterceptorEnabled', 'scriptInterceptorEnabled', 'rulesInterceptorEnabled'],
    (result) => {
      setChipState(evalInterceptBtn,   result.evalInterceptorEnabled   ?? true);
      setChipState(scriptInterceptBtn, result.scriptInterceptorEnabled ?? true);
      setChipState(rulesInterceptBtn,  result.rulesInterceptorEnabled  ?? true);
    }
  );

  evalInterceptBtn.addEventListener('click', () => {
    const next = !evalInterceptBtn.classList.contains('is-active');
    setChipState(evalInterceptBtn, next);
    chrome.storage.local.set({ evalInterceptorEnabled: next });
  });

  scriptInterceptBtn.addEventListener('click', () => {
    const next = !scriptInterceptBtn.classList.contains('is-active');
    setChipState(scriptInterceptBtn, next);
    chrome.storage.local.set({ scriptInterceptorEnabled: next });
  });

  rulesInterceptBtn.addEventListener('click', () => {
    const next = !rulesInterceptBtn.classList.contains('is-active');
    setChipState(rulesInterceptBtn, next);
    chrome.storage.local.set({ rulesInterceptorEnabled: next });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('evalInterceptorEnabled' in changes) {
      setChipState(evalInterceptBtn, changes.evalInterceptorEnabled.newValue ?? true);
    }
    if ('scriptInterceptorEnabled' in changes) {
      setChipState(scriptInterceptBtn, changes.scriptInterceptorEnabled.newValue ?? true);
    }
    if ('rulesInterceptorEnabled' in changes) {
      setChipState(rulesInterceptBtn, changes.rulesInterceptorEnabled.newValue ?? true);
    }
  });

  // ── Rule-call → Tag bridge ───────────────────────────────────────
  // Route Insider.rules.call(id, builderId) events into the Tags view:
  // synthesize a Custom-Rule-<builderId>-<ruleId> tag so one row per rule
  // lands under the correct campaign drawer. Re-triggers of the same rule
  // increment the existing row's hit count instead of appending new rows.
  // Calls without builderId or id are dropped.
  const ruleIdByTag    = new Map(); // tag → rule id (for source-URL button)
  const sourcedRuleIds = new Set(); // rule ids already annotated with sourceURL
  // builderIds already covered by the eval interceptor's Custom-Rule-<bid>-*
  // tag. When Insider.rules.call runs, fns.eval executes inside it and the
  // eval interceptor emits first, so by the time routeRuleCall fires the
  // set is populated — we drop the rules event to avoid a duplicate row.
  const evalSeenBuilders = new Set();

  function routeRuleCall(msg) {
    if (!msg.builderId || msg.id == null) return;
    const builderId = String(msg.builderId);
    if (evalSeenBuilders.has(builderId)) return;
    const ruleId    = String(msg.id);
    const tag = 'Custom-Rule-' + builderId + '-' + ruleId;
    ruleIdByTag.set(tag, ruleId);
    handleTagSeen(tag);
  }

  function syncSourceBtn(row) {
    if (!row._sourceBtn) return;
    const ruleId = ruleIdByTag.get(row._tag);
    const hide = !ruleId || sourcedRuleIds.has(ruleId);
    row._sourceBtn.classList.toggle('hidden', hide);
  }

  function annotateRuleFromRow(row) {
    const ruleId = ruleIdByTag.get(row._tag);
    const parsed = parseTag(row._tag);
    if (!ruleId || !parsed) return;
    const builderId = parsed.id;
    const expr = '(function(){try{return !!(window.__liAnnotateRule&&window.__liAnnotateRule('
      + JSON.stringify(ruleId) + ',' + JSON.stringify(builderId) + '));}catch(e){return false;}})()';
    evalOnPage(expr).then((ok) => {
      if (ok) {
        sourcedRuleIds.add(ruleId);
        rowEls.forEach(syncSourceBtn);
      } else {
        showToast("Source couldn't be found", 'error');
        if (row._sourceBtn) {
          row._sourceBtn.classList.add('is-error');
          row._sourceBtn.title = 'Could not annotate — rule missing or Insider.rules not ready';
          setTimeout(() => row._sourceBtn && row._sourceBtn.classList.remove('is-error'), 1500);
        }
      }
    });
  }

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

  // Long-lived port to SW — chrome.runtime.sendMessage broadcasts don't reach
  // devtools pages in MV3, so SW forwards tag/outcome events through this port.
  function handlePortMessage(msg) {
    if (!msg) return;
    if (msg.type === 'li-tag-seen' && msg.tag) {
      if (!currentOrigin && msg.origin) setOrigin(msg.origin);
      const parsedSeen = parseTag(msg.tag);
      if (parsedSeen && parsedSeen.type === 'Custom-Rule') {
        evalSeenBuilders.add(parsedSeen.id);
      }
      handleTagSeen(msg.tag);
      return;
    }
    if (msg.type === 'li-rule-outcome' && msg.tag && msg.outcome) {
      outcomes.set(msg.tag, {
        outcome: msg.outcome,
        at: Date.now(),
        message: msg.message || null
      });
      const row = rowEls.get(msg.tag);
      if (row) syncInstanceRow(row);
      return;
    }
    if (msg.type === 'li-rule-call' && msg.id != null) {
      if (!currentOrigin && msg.origin) setOrigin(msg.origin);
      routeRuleCall(msg);
    }
  }

  function openPanelPort() {
    if (inspectedTabId == null) return;
    const port = chrome.runtime.connect({ name: 'li-devtools-' + inspectedTabId });
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => {
      // SW idle-restart closes the port; reopen so we don't miss future tags.
      setTimeout(openPanelPort, 100);
    });
  }
  openPanelPort();

  // Ask the content script to replay events it saw before the panel opened.
  // Guarded so SW-idle port reconnects don't trigger duplicate replays;
  // reset on navigation since the new page's content script starts empty.
  let replayRequested = false;
  function requestReplay() {
    if (replayRequested || inspectedTabId == null) return;
    replayRequested = true;
    try {
      chrome.runtime.sendMessage(
        { type: 'li-request-replay', tabId: inspectedTabId },
        () => void chrome.runtime.lastError
      );
    } catch (_) { /* SW may be asleep; next live event will wake it */ }
  }
  requestReplay();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('liBreakTags' in changes)) return;
    if (localWriteInFlight) { localWriteInFlight = false; return; }
    readBreakSetFromStorage();
  });

  if (chrome.devtools && chrome.devtools.network) {
    chrome.devtools.network.onNavigated.addListener(() => {
      clearTags();
      applyTestingVariation(null);
      resolveOrigin();
      replayRequested = false;
    });
  }

  // ── Tooltip (delegated, data-tip) ────────────────────────────────
  // Usage on any element:
  //   data-tip="Title"                 — required
  //   data-tip-desc="Extra detail."    — optional, shown under title
  //   data-tip-kbd="⌘R"                — optional keyboard hint chip
  //   data-tip-placement="top|bottom"  — optional, defaults to auto
  (() => {
    const SHOW_DELAY = 380;
    const HIDE_DELAY = 80;
    const MARGIN = 8;
    const GAP = 6;

    let tipEl = null, titleEl = null, descEl = null, kbdEl = null;
    let currentTarget = null;
    let showTimer = 0, hideTimer = 0;

    function ensureEl() {
      if (tipEl) return;
      tipEl = document.createElement('div');
      tipEl.className = 'tip';
      tipEl.setAttribute('role', 'tooltip');
      tipEl.innerHTML =
        '<span class="tip-head">' +
          '<span class="tip-title"></span>' +
          '<span class="tip-kbd"></span>' +
        '</span>' +
        '<span class="tip-desc"></span>';
      document.body.appendChild(tipEl);
      titleEl = tipEl.querySelector('.tip-title');
      descEl  = tipEl.querySelector('.tip-desc');
      kbdEl   = tipEl.querySelector('.tip-kbd');
    }

    function findTarget(el) {
      return (el && el.closest) ? el.closest('[data-tip]') : null;
    }

    function show(target) {
      ensureEl();
      titleEl.textContent = target.getAttribute('data-tip') || '';
      const desc = target.getAttribute('data-tip-desc') || '';
      const kbd  = target.getAttribute('data-tip-kbd')  || '';
      descEl.textContent = desc;
      kbdEl.textContent  = kbd;
      tipEl.classList.toggle('has-desc', !!desc);
      tipEl.classList.toggle('has-kbd',  !!kbd);

      tipEl.style.left = '0px';
      tipEl.style.top  = '0px';

      const rect = target.getBoundingClientRect();
      const tipRect = tipEl.getBoundingClientRect();
      const vw = window.innerWidth;

      let placement = target.getAttribute('data-tip-placement') || 'auto';
      if (placement === 'auto') {
        placement = (rect.top - tipRect.height - GAP >= MARGIN) ? 'top' : 'bottom';
      }
      tipEl.dataset.placement = placement;

      const top = placement === 'top'
        ? rect.top - tipRect.height - GAP
        : rect.bottom + GAP;

      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      left = Math.max(MARGIN, Math.min(left, vw - tipRect.width - MARGIN));

      const arrowX = rect.left + rect.width / 2 - left;
      tipEl.style.setProperty(
        '--tip-arrow-x',
        Math.max(10, Math.min(tipRect.width - 10, arrowX)) + 'px'
      );

      tipEl.style.left = Math.round(left) + 'px';
      tipEl.style.top  = Math.round(top)  + 'px';

      requestAnimationFrame(() => tipEl.classList.add('is-visible'));
    }

    function hide() {
      if (tipEl) tipEl.classList.remove('is-visible');
      currentTarget = null;
      hideTimer = 0;
    }

    function scheduleShow(target) {
      if (currentTarget === target) return;
      clearTimeout(hideTimer); hideTimer = 0;
      const wasVisible = tipEl && tipEl.classList.contains('is-visible');
      currentTarget = target;
      clearTimeout(showTimer);
      showTimer = setTimeout(() => show(target), wasVisible ? 0 : SHOW_DELAY);
    }

    function scheduleHide() {
      clearTimeout(showTimer); showTimer = 0;
      if (!tipEl || !tipEl.classList.contains('is-visible')) {
        currentTarget = null;
        return;
      }
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, HIDE_DELAY);
    }

    document.addEventListener('mouseover', (e) => {
      const t = findTarget(e.target);
      if (t) scheduleShow(t);
    });
    document.addEventListener('mouseout', (e) => {
      const from = findTarget(e.target);
      const to   = findTarget(e.relatedTarget);
      if (from && from !== to) scheduleHide();
    });
    document.addEventListener('focusin', (e) => {
      const t = findTarget(e.target);
      if (t) scheduleShow(t);
    });
    document.addEventListener('focusout', (e) => {
      if (findTarget(e.target)) scheduleHide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tipEl && tipEl.classList.contains('is-visible')) hide();
    });
    window.addEventListener('scroll', () => { if (currentTarget) hide(); }, true);
    window.addEventListener('blur', hide);
  })();

  // ── Init ─────────────────────────────────────────────────────────

  resolveOrigin();
  pollTestingVariation();
  testingPollTimer = setInterval(pollTestingVariation, 1500);

})();
