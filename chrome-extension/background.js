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
        updateBadge(true);
        startHeartbeat();
        console.log('[Live Injector v2] Connected to VS Code embedded server');
      };

      socket.onclose = (event) => {
        isConnected = false;
        socket = null;
        stopHeartbeat();
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
        updateBadge(false);
        console.log(`[Live Injector v2] Disconnected (${event.code})`);

        if (!manuallyDisconnected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(3000 + reconnectAttempts * 2000, 30000);
          console.log(`[Live Injector v2] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          setTimeout(connectToServer, delay);
        }
      };

      socket.onerror = () => {
        isConnected = false;
        updateBadge(false);
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
      updateBadge(false);
      if (!manuallyDisconnected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        setTimeout(connectToServer, 3000);
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

// ── Badge ─────────────────────────────────────────────────────────

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? '✓' : '✗' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#4CAF50' : '#F44336' });
}

// ── Messages from popup ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'get-status':
      sendResponse({ connected: isConnected, reconnectAttempts, maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS });
      break;

    case 'reconnect':
      manuallyDisconnected = false;
      reconnectAttempts = 0;
      if (socket) { socket.close(); }
      setTimeout(connectToServer, 300);
      sendResponse({ status: 'reconnecting' });
      break;

    case 'disconnect':
      manuallyDisconnected = true;
      stopHeartbeat();
      if (socket) { socket.close(); socket = null; }
      isConnected = false;
      updateBadge(false);
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
  return true;
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

connectToServer();
