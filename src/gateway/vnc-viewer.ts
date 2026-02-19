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
    .lbl{color:#5c6072;white-space:nowrap}
    .val{color:#8b8fa3;white-space:nowrap}
    .val.ok{color:#4ade80}.val.err{color:#f87171}.val.off{color:#5c6072}
    .sep{width:1px;height:16px;background:#2e3140;flex-shrink:0}
    .ctrl-btn{display:flex;align-items:center;justify-content:center;height:24px;padding:0 8px;
      border:none;background:transparent;border-radius:4px;cursor:pointer;color:#8b8fa3;
      font-size:10px;font-family:inherit;white-space:nowrap;transition:all .15s}
    .ctrl-btn:hover{background:#2f323c;color:#e4e6eb}
    .ctrl-btn.danger:hover{background:#7f1d1d;color:#fca5a5}
    .ctrl-btn.primary:hover{background:#1e3a5f;color:#93c5fd}
    .ctrl-btn:disabled{opacity:.4;cursor:not-allowed}
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
    .overlay-btn:hover{background:#5a76e0}
  </style>
</head>
<body>
  <div id="toolbar">
    <div style="display:flex;align-items:center;gap:6px">
      <div class="dot" id="vnc-dot"></div>
      <span class="val" id="status-text">Loading...</span>
    </div>
    <div class="sep"></div>
    <span class="lbl">PID</span><span class="val" id="s-pid">&mdash;</span>
    <span class="lbl">CDP</span><span class="val" id="s-cdp">&mdash;</span>
    <span class="lbl">Stealth</span><span class="val" id="s-stealth">&mdash;</span>
    <span class="lbl">Proxy</span><span class="val" id="s-proxy">&mdash;</span>
    <span class="lbl">Captcha</span><span class="val" id="s-captcha">&mdash;</span>
    <div class="sep"></div>
    <button class="ctrl-btn primary" id="btn-start">&#9654; Start</button>
    <button class="ctrl-btn danger" id="btn-stop">&#9209; Stop</button>
    <button class="ctrl-btn" id="btn-restart">&#8635; Restart</button>
    <div style="flex:1"></div>
    <a href="/" class="toolbar-link">&larr; Control UI</a>
    <button class="ctrl-btn" id="btn-fs">&#9974;</button>
  </div>
  <div id="screen">
    <div id="overlay">
      <div class="spinner" id="ov-spin"></div>
      <div class="overlay-text" id="ov-text">Loading...</div>
      <button class="overlay-btn" id="ov-btn" style="display:none">Start Browser</button>
      <pre id="ov-log" style="display:none;max-width:80%;max-height:200px;overflow:auto;
        background:#1a1d27;border:1px solid #2e3140;border-radius:6px;padding:10px;
        font-size:11px;color:#f87171;text-align:left;white-space:pre-wrap;word-break:break-all"></pre>
    </div>
  </div>

  <script>
    var apiBase = location.pathname.replace(/\\/+$/, '') + '/api';
    var RFB = null, rfb = null, retryDelay = 2000;

    var $ = document.getElementById.bind(document);
    var $dot = $('vnc-dot'), $st = $('status-text'), $scr = $('screen');
    var $ov = $('overlay'), $ovText = $('ov-text'), $ovSpin = $('ov-spin'), $ovBtn = $('ov-btn');

    var $ovLog = $('ov-log');
    function showOv(t, spin, btn, log) {
      $ov.classList.remove('hidden'); $ovText.textContent = t;
      $ovSpin.style.display = spin ? '' : 'none';
      $ovBtn.style.display = btn ? '' : 'none';
      if (log) { $ovLog.style.display = ''; $ovLog.textContent = log; }
      else { $ovLog.style.display = 'none'; }
    }
    function hideOv() { $ov.classList.add('hidden'); }

    function tag(id, text, cls) {
      var el = $(id); el.textContent = text; el.className = 'val' + (cls ? ' ' + cls : '');
    }

    function api(path, method) {
      return fetch(apiBase + '/' + path, method ? {method:method} : {})
        .then(function(r){return r.ok ? r.json() : null}).catch(function(){return null});
    }

    function refreshStatus() {
      return api('status').then(function(d) {
        if (!d) return null;
        tag('s-pid', d.pid || '\\u2014', d.pid ? '' : 'off');
        tag('s-cdp', d.cdpPort ? ':' + d.cdpPort : 'down', d.cdpPort ? 'ok' : 'err');

        var s = d.stealth;
        if (s) {
          tag('s-stealth', s.enabled ? 'on' : 'off', s.enabled ? 'ok' : 'off');
          tag('s-proxy', s.proxy ? 'on' : 'off', s.proxy ? 'ok' : 'off');
          tag('s-captcha', s.captcha ? (s.captcha.configured ? s.captcha.provider : 'no key') : 'off',
            s.captcha && s.captcha.configured ? 'ok' : 'off');
        } else {
          tag('s-stealth', 'n/a', 'off');
          tag('s-proxy', 'n/a', 'off');
          tag('s-captcha', 'n/a', 'off');
        }

        $('btn-start').disabled = !!d.running;
        $('btn-stop').disabled = !d.running;
        return d;
      });
    }

    function doAction(action) {
      document.querySelectorAll('.ctrl-btn').forEach(function(b){b.disabled=true});
      showOv(action === 'start' ? 'Starting browser...' : action === 'stop' ? 'Stopping...' : 'Restarting...', true, false);
      api(action, 'POST').then(function(result){
        if (result && result.error) {
          showOv('Failed to ' + action + ' browser', false, true, result.error);
          document.querySelectorAll('.ctrl-btn').forEach(function(b){b.disabled=false});
          refreshStatus();
          return;
        }
        if (action === 'stop') {
          refreshStatus().then(function(){
            document.querySelectorAll('.ctrl-btn').forEach(function(b){b.disabled=false});
            tryConnect();
          });
          return;
        }
        // Poll until browser is actually running
        var polls = 0, maxPolls = 15;
        function pollUntilReady() {
          polls++;
          refreshStatus().then(function(d) {
            if (d && d.running) {
              document.querySelectorAll('.ctrl-btn').forEach(function(b){b.disabled=false});
              tryConnect();
            } else if (polls < maxPolls) {
              setTimeout(pollUntilReady, 1000);
            } else {
              showOv('Browser failed to start', false, true, 'Timed out waiting for Chrome to become ready');
              document.querySelectorAll('.ctrl-btn').forEach(function(b){b.disabled=false});
            }
          });
        }
        setTimeout(pollUntilReady, 1000);
      });
    }

    $('btn-start').onclick = function(){doAction('start')};
    $('btn-stop').onclick = function(){doAction('stop')};
    $('btn-restart').onclick = function(){doAction('restart')};
    $ovBtn.onclick = function(){doAction('start')};
    $('btn-fs').onclick = function(){
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    };
    window.onresize = function(){if(rfb)rfb.scaleViewport=true};

    function wsUrl() {
      var p = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return p + '//' + location.host + location.pathname.replace(/\\/+$/, '') + '/ws';
    }

    function tryConnect() {
      refreshStatus().then(function(d) {
        if (!d || !d.running) {
          $dot.className = 'dot';
          $st.textContent = d ? 'Browser stopped' : 'API unreachable';
          showOv(d ? 'Browser is not running' : 'Cannot reach API', false, true);
          return;
        }
        $dot.className = 'dot warn';
        $st.textContent = 'Connecting...';
        showOv('Connecting to display...', true, false);
        if (RFB) { doConnect(); return; }
        import(location.pathname.replace(/\\/+$/, '') + '/novnc/core/rfb.js').then(function(m){
          RFB = m.default; doConnect();
        }).catch(function(err){
          console.error('noVNC load failed:', err);
          $st.textContent = 'VNC module error';
          showOv('Failed to load VNC viewer: ' + (err.message || err), false, false);
        });
      });
    }

    function doConnect() {
      try {
        if(rfb){try{rfb.disconnect()}catch(e){}rfb=null}
        rfb = new RFB($scr, wsUrl(), {
          scaleViewport:true, clipViewport:true, resizeSession:false,
          showDotCursor:true, qualityLevel:6, compressionLevel:2
        });
        rfb.addEventListener('connect', function(){
          retryDelay=2000; $dot.className='dot on'; $st.textContent='Connected';
          hideOv(); setTimeout(function(){if(rfb)rfb.scaleViewport=true},200);
        });
        rfb.addEventListener('disconnect', function(e){
          rfb=null; $dot.className='dot';
          var msg = e.detail.clean ? 'Disconnected' : 'Connection lost';
          $st.textContent=msg; showOv(msg+'. Reconnecting...',true,false);
          retryDelay=Math.min(retryDelay*1.5,15000);
          setTimeout(tryConnect,retryDelay);
        });
      } catch(err){
        rfb=null; $st.textContent='Connection failed';
        showOv('Could not connect. Retrying...',true,false);
        retryDelay=Math.min(retryDelay*1.5,15000);
        setTimeout(tryConnect,retryDelay);
      }
    }

    // Boot
    refreshStatus().then(tryConnect);
    setInterval(refreshStatus, 5000);
  </script>
</body>
</html>
`;
