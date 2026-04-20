// Background service worker — Live Code Injector v2
// Connects directly to the embedded WebSocket server inside the VS Code extension.

const DEFAULT_PORT = 8765;
const HEARTBEAT_INTERVAL_MS = 10000; // 10s — less noise than v1's 2s
const MAX_RECONNECT_ATTEMPTS = 10;
const CONNECTION_TIMEOUT_MS = 5000;

let socket = null;
let isConnected = false;
let reconnectAttempts = 0;
let manuallyDisconnected = false;
let heartbeatInterval = null;
let connectionTimeout = null;

// ── Connection ────────────────────────────────────────────────────

function connectToServer() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  if (connectionTimeout) {
    clearTimeout(connectionTimeout);
  }

  getPort().then(port => {
    try {
      socket = new WebSocket(`ws://localhost:${port}`);

      connectionTimeout = setTimeout(() => {
        if (socket && socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }, CONNECTION_TIMEOUT_MS);

      socket.onopen = () => {
        isConnected = true;
        reconnectAttempts = 0;
        manuallyDisconnected = false;
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
        setStatus('connected');
        startHeartbeat();
        console.log('[Live Injector v2] Connected to VS Code embedded server');
      };

      socket.onclose = (event) => {
        isConnected = false;
        socket = null;
        stopHeartbeat();
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
        console.log(`[Live Injector v2] Disconnected (${event.code})`);

        if (!manuallyDisconnected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(3000 + reconnectAttempts * 2000, 30000);
          console.log(`[Live Injector v2] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          setStatus('connecting');
          setTimeout(connectToServer, delay);
        } else {
          setStatus('disconnected');
        }
      };

      socket.onerror = () => {
        isConnected = false;
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'pong') { return; }
          handleCodeExecution(data);
        } catch (e) {
          console.error('[Live Injector v2] Error parsing message:', e);
        }
      };

    } catch (err) {
      console.error('[Live Injector v2] Connection error:', err);
      isConnected = false;
      if (!manuallyDisconnected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        setStatus('connecting');
        setTimeout(connectToServer, 3000);
      } else {
        setStatus('disconnected');
      }
    }
  });
}

// ── Heartbeat ─────────────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now(), source: 'chrome-extension-v2' }));
    } else {
      stopHeartbeat();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ── Port helper ───────────────────────────────────────────────────

async function getPort() {
  const result = await chrome.storage.local.get('serverPort');
  return result.serverPort || DEFAULT_PORT;
}

// ── Action icon ───────────────────────────────────────────────────
// Instead of a text badge, we composite a status dot onto the base icon
// at runtime. Three states: connected (green), disconnected (red with
// desaturated base mark), connecting (pulsing amber). Colours echo the
// popup's --green / --red tokens so the toolbar and popup feel unified.

const ICON_SIZES = [16, 32, 48, 128];
const ICON_TOOLBAR_SIZES = [16, 32];

const STATUS_COLORS = {
  connected:    { dot: '#3BD66F', halo: 'rgba(59, 214, 111, 0.55)' },
  disconnected: { dot: '#F04A4A', halo: 'rgba(240, 74, 74, 0.50)'  },
  connecting:   { dot: '#F5B43C', halo: 'rgba(245, 180, 60, 0.55)' },
};

let baseIcons = null;
let baseIconsLoading = null;
let pulseInterval = null;

function loadBaseIcons() {
  if (baseIcons) { return Promise.resolve(baseIcons); }
  if (baseIconsLoading) { return baseIconsLoading; }

  baseIconsLoading = Promise.all(
    ICON_SIZES.map(async size => {
      const res = await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`));
      const blob = await res.blob();
      return [size, await createImageBitmap(blob)];
    })
  ).then(entries => {
    baseIcons = Object.fromEntries(entries);
    baseIconsLoading = null;
    return baseIcons;
  });

  return baseIconsLoading;
}

function renderIcon(size, state, pulsePhase = 1) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');

  if (state === 'disconnected') {
    ctx.filter = 'grayscale(0.55) brightness(0.78)';
  }
  ctx.drawImage(baseIcons[size], 0, 0, size, size);
  ctx.filter = 'none';

  const { dot, halo } = STATUS_COLORS[state];
  const r    = Math.max(2, Math.round(size * 0.22));
  const pad  = Math.max(1, Math.round(size * 0.03));
  const cx   = size - r - pad;
  const cy   = size - r - pad;
  const haloR = r * 2.1;

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
  grad.addColorStop(0, halo);
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.globalAlpha = state === 'connecting' ? pulsePhase : 1;
  ctx.fillStyle = grad;
  ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = dot;
  ctx.fill();
  ctx.lineWidth   = Math.max(1, size * 0.05);
  ctx.strokeStyle = 'rgba(10, 10, 14, 0.75)';
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

async function applyIcon(state, pulsePhase = 1, sizes = ICON_SIZES) {
  try {
    await loadBaseIcons();
    const imageData = {};
    for (const s of sizes) { imageData[s] = renderIcon(s, state, pulsePhase); }
    await chrome.action.setIcon({ imageData });
  } catch (e) {
    console.warn('[Live Injector v2] Icon render failed:', e);
  }
}

async function setActionTitle(state) {
  let title;
  if (state === 'connected') {
    const port = await getPort();
    title = `Live Injector — Connected · :${port}`;
  } else if (state === 'connecting') {
    title = `Live Injector — Reconnecting ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}…`;
  } else {
    title = 'Live Injector — Disconnected · click to reconnect';
  }
  chrome.action.setTitle({ title });
}

function stopPulse() {
  if (pulseInterval) { clearInterval(pulseInterval); pulseInterval = null; }
}

function startPulse() {
  stopPulse();
  let step = 0;
  const STEPS = 10;
  pulseInterval = setInterval(() => {
    step = (step + 1) % STEPS;
    // Eased sine between 0.45 and 1.0 — a slow breath, not a strobe.
    const t = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin((step / STEPS) * Math.PI * 2));
    applyIcon('connecting', t, ICON_TOOLBAR_SIZES);
  }, 220);
}

function setStatus(state) {
  stopPulse();
  chrome.action.setBadgeText({ text: '' });
  applyIcon(state);
  setActionTitle(state);
  if (state === 'connecting') { startPulse(); }
}

// ── DevTools panel ports (SW → panel relay) ──────────────────────
// chrome.runtime.sendMessage broadcasts don't reliably reach DevTools extension
// pages in MV3. Panels open a long-lived Port named 'li-devtools-<tabId>' and
// we forward content-script messages for that tab through the port.

const panelPorts = new Map(); // tabId → Port

chrome.runtime.onConnect.addListener((port) => {
  const m = /^li-devtools-(\d+)$/.exec(port.name || '');
  if (!m) return;
  const tabId = Number(m[1]);
  panelPorts.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (panelPorts.get(tabId) === port) panelPorts.delete(tabId);
  });
});

function relayToPanel(tabId, msg) {
  const port = tabId != null ? panelPorts.get(tabId) : null;
  if (!port) return;
  try { port.postMessage(msg); } catch (_) { panelPorts.delete(tabId); }
}

// ── Messages from content scripts / popup ─────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'li-tag-seen') {
    const tabId = _sender && _sender.tab && _sender.tab.id;
    relayToPanel(tabId, { type: 'li-tag-seen', tag: message.tag, origin: message.origin });
    return;
  }
  if (message && message.type === 'li-rule-outcome') {
    const tabId = _sender && _sender.tab && _sender.tab.id;
    relayToPanel(tabId, {
      type: 'li-rule-outcome',
      tag: message.tag,
      outcome: message.outcome,
      message: message.message,
      origin: message.origin
    });
    return;
  }
  if (message && message.type === 'li-rule-call') {
    const tabId = _sender && _sender.tab && _sender.tab.id;
    relayToPanel(tabId, {
      type: 'li-rule-call',
      id: message.id,
      builderId: message.builderId,
      ok: message.ok,
      result: message.result,
      durationMs: message.durationMs,
      error: message.error,
      ts: message.ts,
      origin: message.origin
    });
    return;
  }
  switch (message.type) {
    case 'get-status':
      sendResponse({ connected: isConnected, reconnectAttempts, maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS });
      break;

    case 'reconnect':
      manuallyDisconnected = false;
      reconnectAttempts = 0;
      if (socket) { socket.close(); }
      setStatus('connecting');
      setTimeout(connectToServer, 300);
      sendResponse({ status: 'reconnecting' });
      break;

    case 'disconnect':
      manuallyDisconnected = true;
      stopHeartbeat();
      if (socket) { socket.close(); socket = null; }
      isConnected = false;
      setStatus('disconnected');
      sendResponse({ status: 'disconnected' });
      break;

    case 'test':
      if (isConnected && socket) {
        socket.send(JSON.stringify({ type: 'test', message: 'Test from Chrome extension v2' }));
        sendResponse({ status: 'test sent' });
      } else {
        sendResponse({ status: 'not connected' });
      }
      break;
  }
});

// ── Code execution ────────────────────────────────────────────────

async function handleCodeExecution(data) {
  const { type, code, filename } = data;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.error('[Live Injector v2] No active tab found');
      return;
    }

    if (type === 'javascript') {
      const storageResult = await chrome.storage.local.get(['preamble', 'clearEvents']);
      const preamble     = storageResult.preamble    || '';
      const clearEvents  = storageResult.clearEvents || false;
      const clearLine    = clearEvents ? 'Insider.eventManager.clearAll();\n\n' : '';
      const finalCode    = `${clearLine}${preamble ? `${preamble};\n\n` : ''}${code}`;

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: injectJavaScript,
          args: [finalCode, filename]
        });
      } catch {
        // Fallback for stricter CSP pages
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: injectJavaScriptFallback,
          args: [finalCode, filename]
        });
      }
    } else if (type === 'css') {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectCSS,
        args: [code, filename]
      });
    }

    chrome.tabs.sendMessage(tab.id, {
      type: 'code-executed',
      filename,
      codeType: type
    }).catch(() => { /* popup may not be open */ });

  } catch (err) {
    console.error('[Live Injector v2] Execution error:', err);
  }
}

// ── Injected functions (run in page context) ──────────────────────

function injectJavaScript(code, filename) {
  const existing = document.querySelector(`script[data-live-injector="${CSS.escape(filename)}"]`);
  if (existing) { existing.remove(); }

  const script = document.createElement('script');
  script.textContent = `;(() => {\n${code}\n})();`;
  script.setAttribute('data-live-injector', filename);
  (document.head || document.documentElement).appendChild(script);

  setTimeout(() => { if (script.parentNode) { script.remove(); } }, 100);
  console.log(`%c[Live Injector v2] Executed JS: ${filename}`, 'color:#4CAF50;font-weight:bold');
}

function injectJavaScriptFallback(code, filename) {
  const blob = new Blob([`;(() => {\n${code}\n})();`], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const script = document.createElement('script');
  script.src = url;
  script.setAttribute('data-live-injector-fallback', filename);
  script.onload = () => { URL.revokeObjectURL(url); script.remove(); };
  script.onerror = () => { URL.revokeObjectURL(url); script.remove(); };
  (document.head || document.documentElement).appendChild(script);
}

function injectCSS(code, filename) {
  const existing = document.querySelector(`style[data-live-injector="${CSS.escape(filename)}"]`);
  if (existing) { existing.remove(); }

  const style = document.createElement('style');
  style.setAttribute('data-live-injector', filename);
  style.textContent = code;
  document.head.appendChild(style);
  console.log(`%c[Live Injector v2] Injected CSS: ${filename}`, 'color:#2196F3;font-weight:bold');
}

// ── Init ──────────────────────────────────────────────────────────

setStatus('connecting');
connectToServer();
