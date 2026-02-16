export const VNC_VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Browser - OpenClaw</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;width:100%;overflow:hidden;background:#0f1117;color:#e4e6eb;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
    #toolbar{position:fixed;top:0;left:0;right:0;height:36px;display:flex;align-items:center;gap:6px;
      padding:0 10px;background:#1a1d27;border-bottom:1px solid #2e3140;z-index:20;font-size:11px}
    .dot{width:7px;height:7px;border-radius:50%;background:#f87171;flex-shrink:0;transition:background .3s}
    .dot.on{background:#4ade80}.dot.warn{background:#fbbf24;animation:pulse 1s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    #status-text{color:#8b8fa3;white-space:nowrap}
    .stats{display:flex;align-items:center;gap:10px;color:#5c6072;font-size:11px;white-space:nowrap}
    .stats .stat{display:flex;align-items:center;gap:3px}.stats .val{color:#8b8fa3}
    .sep{width:1px;height:16px;background:#2e3140;flex-shrink:0}
    .ctrl-group{display:flex;align-items:center;gap:2px}
    .ctrl-btn{display:flex;align-items:center;justify-content:center;height:24px;padding:0 8px;
      border:none;background:transparent;border-radius:4px;cursor:pointer;color:#8b8fa3;
      font-size:10px;font-family:inherit;white-space:nowrap;transition:all .15s}
    .ctrl-btn:hover{background:#2f323c;color:#e4e6eb}
    .ctrl-btn.danger:hover{background:#7f1d1d;color:#fca5a5}
    .ctrl-btn.primary:hover{background:#1e3a5f;color:#93c5fd}
    .ctrl-btn:disabled{opacity:.4;cursor:not-allowed}
    .ctrl-btn:disabled:hover{background:transparent;color:#8b8fa3}
    .toolbar-link{font-size:11px;color:#6c8aff;text-decoration:none;padding:4px 8px;border-radius:4px;white-space:nowrap}
    .toolbar-link:hover{background:#2f323c}
    #screen{position:fixed;top:36px;left:0;right:0;bottom:0;background:#0f1117;overflow:hidden}
    #overlay{position:absolute;inset:0;background:#0f1117;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:16px;z-index:10}
    #overlay.hidden{display:none}
    .spinner{width:40px;height:40px;border:3px solid #2e3140;border-top-color:#6c8aff;
      border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .overlay-text{font-size:14px;color:#8b8fa3}
    .overlay-btn{padding:10px 28px;border:none;border-radius:6px;cursor:pointer;font-size:14px;
      font-family:inherit;font-weight:500;background:#6c8aff;color:#fff;transition:background .15s}
    .overlay-btn:hover{background:#5a76e0}.overlay-btn:disabled{opacity:.5;cursor:not-allowed}
  </style>
</head>
<body>
  <div id="toolbar">
    <div style="display:flex;align-items:center;gap:6px">
      <div class="dot" id="vnc-dot"></div>
      <span id="status-text">Loading...</span>
    </div>
    <div class="sep"></div>
    <div class="stats">
      <div class="stat">PID <span class="val" id="s-pid">&mdash;</span></div>
      <div class="stat">CDP <span class="val" id="s-cdp">&mdash;</span></div>
      <div class="stat">Tabs <span class="val" id="s-tabs">&mdash;</span></div>
    </div>
    <div class="sep"></div>
    <div class="ctrl-group">
      <button class="ctrl-btn primary" id="btn-start">&#9654; Start</button>
      <button class="ctrl-btn danger" id="btn-stop">&#9209; Stop</button>
      <button class="ctrl-btn" id="btn-restart">&#8635; Restart</button>
    </div>
    <div style="flex:1"></div>
    <a href="/" class="toolbar-link">&larr; Control UI</a>
    <button class="ctrl-btn" id="btn-fs">&#9974;</button>
  </div>
  <div id="screen">
    <div id="overlay">
      <div class="spinner" id="ov-spin"></div>
      <div class="overlay-text" id="ov-text">Loading...</div>
      <button class="overlay-btn" id="ov-btn" style="display:none">Start Browser</button>
    </div>
  </div>

  <script>
    // --- No module import at top level. UI boots immediately. ---
    var apiBase = location.pathname.replace(/\\/+$/, '') + '/api';
    var RFB = null, rfb = null, retryDelay = 2000;

    var $dot = document.getElementById('vnc-dot');
    var $st = document.getElementById('status-text');
    var $scr = document.getElementById('screen');
    var $ov = document.getElementById('overlay');
    var $ovText = document.getElementById('ov-text');
    var $ovSpin = document.getElementById('ov-spin');
    var $ovBtn = document.getElementById('ov-btn');
    var $pid = document.getElementById('s-pid');
    var $cdp = document.getElementById('s-cdp');
    var $tabs = document.getElementById('s-tabs');

    function showOv(text, spin, btn) {
      $ov.classList.remove('hidden');
      $ovText.textContent = text;
      $ovSpin.style.display = spin ? '' : 'none';
      $ovBtn.style.display = btn ? '' : 'none';
    }
    function hideOv() { $ov.classList.add('hidden'); }

    // --- API ---
    function api(path, method) {
      return fetch(apiBase + '/' + path, method ? { method: method } : {}).then(function(r) {
        return r.ok ? r.json() : null;
      }).catch(function() { return null; });
    }

    function refreshStatus() {
      return api('status').then(function(d) {
        if (!d) return null;
        $pid.textContent = d.pid || '\\u2014';
        $cdp.textContent = d.cdpReady ? '\\u2713' : '\\u2717';
        $cdp.style.color = d.cdpReady ? '#4ade80' : '#f87171';
        $tabs.textContent = d.tabs != null ? d.tabs : '\\u2014';
        document.getElementById('btn-start').disabled = !!d.running;
        document.getElementById('btn-stop').disabled = !d.running;
        return d;
      });
    }

    function doAction(action) {
      document.querySelectorAll('.ctrl-btn').forEach(function(b){b.disabled=true});
      showOv(action === 'start' ? 'Starting browser...' : action === 'stop' ? 'Stopping...' : 'Restarting...', true, false);
      api(action, 'POST').then(function() {
        return new Promise(function(r){setTimeout(r,2500)});
      }).then(refreshStatus).then(function() {
        document.querySelectorAll('.ctrl-btn').forEach(function(b){b.disabled=false});
        tryConnect();
      });
    }

    document.getElementById('btn-start').onclick = function(){doAction('start')};
    document.getElementById('btn-stop').onclick = function(){doAction('stop')};
    document.getElementById('btn-restart').onclick = function(){doAction('restart')};
    $ovBtn.onclick = function(){doAction('start')};
    document.getElementById('btn-fs').onclick = function(){
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    };
    window.onresize = function(){ if(rfb) rfb.scaleViewport = true; };

    // --- VNC (lazy loaded) ---
    function wsUrl() {
      var p = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return p + '//' + location.host + location.pathname.replace(/\\/+$/, '') + '/ws';
    }

    function tryConnect() {
      refreshStatus().then(function(d) {
        if (!d || !d.running) {
          $dot.className = 'dot';
          $st.textContent = 'Browser stopped';
          showOv('Browser is not running', false, true);
          return;
        }
        $dot.className = 'dot warn';
        $st.textContent = 'Connecting...';
        showOv('Connecting to display...', true, false);

        if (RFB) {
          doConnect();
        } else {
          // Dynamically import noVNC
          import(location.pathname.replace(/\\/+$/, '') + '/novnc/core/rfb.js').then(function(m) {
            RFB = m.default;
            doConnect();
          }).catch(function(err) {
            console.error('noVNC load failed:', err);
            $st.textContent = 'VNC module error';
            showOv('Failed to load VNC viewer', false, false);
          });
        }
      });
    }

    function doConnect() {
      try {
        if (rfb) { try{rfb.disconnect()}catch(e){} rfb = null; }
        rfb = new RFB($scr, wsUrl(), {
          scaleViewport:true, clipViewport:true, resizeSession:false,
          showDotCursor:true, qualityLevel:6, compressionLevel:2
        });
        rfb.addEventListener('connect', function() {
          retryDelay = 2000;
          $dot.className = 'dot on';
          $st.textContent = 'Connected';
          hideOv();
          setTimeout(function(){if(rfb)rfb.scaleViewport=true},200);
        });
        rfb.addEventListener('disconnect', function(e) {
          rfb = null;
          $dot.className = 'dot';
          var msg = e.detail.clean ? 'Disconnected' : 'Connection lost';
          $st.textContent = msg;
          showOv(msg + '. Reconnecting...', true, false);
          retryDelay = Math.min(retryDelay * 1.5, 15000);
          setTimeout(tryConnect, retryDelay);
        });
      } catch(err) {
        rfb = null;
        $st.textContent = 'Connection failed';
        showOv('Could not connect. Retrying...', true, false);
        retryDelay = Math.min(retryDelay * 1.5, 15000);
        setTimeout(tryConnect, retryDelay);
      }
    }

    // --- Boot: UI first, VNC lazy ---
    refreshStatus().then(function() {
      tryConnect();
    });
    setInterval(refreshStatus, 5000);
  </script>
</body>
</html>
`;
