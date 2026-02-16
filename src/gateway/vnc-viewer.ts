export const VNC_VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Browser Viewer - OpenClaw</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; width: 100%; overflow: hidden; background: #0f1117; color: #e4e6eb;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }

    #toolbar {
      position: fixed; top: 0; left: 0; right: 0;
      height: 36px;
      display: flex; align-items: center; gap: 8px;
      padding: 0 12px;
      background: #1a1d27;
      border-bottom: 1px solid #2e3140;
      z-index: 20;
    }
    #status-group { display: flex; align-items: center; gap: 6px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #f87171; transition: background 0.3s; }
    .status-dot.connected { background: #4ade80; }
    .status-dot.connecting { background: #fbbf24; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    #status-text { font-size: 11px; color: #5c6072; white-space: nowrap; }
    .toolbar-btn {
      display: flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border: none; background: transparent;
      border-radius: 6px; cursor: pointer; color: #8b8fa3; font-size: 14px;
    }
    .toolbar-btn:hover { background: #2f323c; color: #e4e6eb; }
    .toolbar-link {
      font-size: 11px; color: #6c8aff; text-decoration: none; padding: 4px 8px;
      border-radius: 4px;
    }
    .toolbar-link:hover { background: #2f323c; }

    #screen-container {
      position: fixed;
      top: 36px; left: 0; right: 0; bottom: 0;
      background: #0f1117;
      overflow: hidden;
    }

    #connect-overlay {
      position: absolute; inset: 0;
      background: #0f1117;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 16px;
      z-index: 10;
    }
    #connect-overlay.hidden { display: none; }
    .connect-spinner {
      width: 40px; height: 40px;
      border: 3px solid #2e3140; border-top-color: #6c8aff;
      border-radius: 50%; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .connect-text { font-size: 14px; color: #8b8fa3; }
  </style>
</head>
<body>
  <div id="toolbar">
    <div id="status-group">
      <div class="status-dot" id="status-dot"></div>
      <span id="status-text">Connecting...</span>
    </div>
    <div style="flex:1"></div>
    <a href="/" class="toolbar-link">← Control UI</a>
    <button class="toolbar-btn" id="btn-fullscreen" title="Fullscreen">⛶</button>
  </div>

  <div id="screen-container">
    <div id="connect-overlay">
      <div class="connect-spinner"></div>
      <div class="connect-text">Connecting to remote display...</div>
    </div>
  </div>

  <script type="module">
    import RFB from "./novnc/core/rfb.js";

    let rfb = null;
    let retryDelay = 2000;

    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const screenContainer = document.getElementById('screen-container');
    const connectOverlay = document.getElementById('connect-overlay');
    const connectText = connectOverlay.querySelector('.connect-text');

    function resolveWsUrl() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsPath = \`\${location.pathname.replace(/\\/+$/, '')}/ws\`;
      return \`\${protocol}//\${location.host}\${wsPath}\`;
    }

    async function connectVNC() {
      statusDot.className = 'status-dot connecting';
      statusText.textContent = 'Connecting...';
      connectText.textContent = 'Connecting to remote display...';
      connectOverlay.classList.remove('hidden');

      const wsUrl = resolveWsUrl();

      try {
        if (rfb) { try { rfb.disconnect(); } catch {} rfb = null; }

        rfb = new RFB(screenContainer, wsUrl, {
          scaleViewport: true,
          clipViewport: true,
          resizeSession: false,
          showDotCursor: true,
          qualityLevel: 6,
          compressionLevel: 2,
        });

        rfb.addEventListener('connect', () => {
          retryDelay = 2000;
          statusDot.className = 'status-dot connected';
          statusText.textContent = 'Connected';
          connectOverlay.classList.add('hidden');
          setTimeout(() => { if (rfb) rfb.scaleViewport = true; }, 200);
        });

        rfb.addEventListener('disconnect', (e) => {
          rfb = null;
          statusDot.className = 'status-dot';
          const msg = e.detail.clean ? 'Disconnected' : 'Connection lost';
          statusText.textContent = msg;
          connectText.textContent = \`\${msg}. Reconnecting...\`;
          connectOverlay.classList.remove('hidden');
          retryDelay = Math.min(retryDelay * 1.5, 15000);
          setTimeout(connectVNC, retryDelay);
        });
      } catch (err) {
        console.warn('VNC connection error:', err?.message ?? String(err));
        rfb = null;
        statusDot.className = 'status-dot';
        statusText.textContent = 'Connection failed';
        connectText.textContent = 'Could not connect. Retrying...';
        retryDelay = Math.min(retryDelay * 1.5, 15000);
        setTimeout(connectVNC, retryDelay);
      }
    }

    window.addEventListener('resize', () => { if (rfb) rfb.scaleViewport = true; });

    document.getElementById('btn-fullscreen').addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    });

    void connectVNC();
  </script>
</body>
</html>
`;
