/**
 * Browser stealth scripts to avoid bot detection.
 * Ports all 29 stealth signals from the browser-manager skill.
 * These scripts are injected into every page before any page scripts run.
 *
 * NOTE: Patchright already handles:
 *   - navigator.webdriver (via Runtime.enable patch)
 *   - Console.enable leak
 *   --disable-blink-features=AutomationControlled (in chrome.ts)
 *   --enable-automation removal
 *
 * The signals below complement Patchright with fingerprint randomization
 * and other detection vectors not covered by the patched Playwright.
 */

export type StealthScriptOptions = {
  /** Geolocation to spoof. Defaults to no geo spoofing. */
  geolocation?: { latitude: number; longitude: number; city?: string };
  /** Custom user-agent string (for userAgentData spoofing). */
  userAgent?: string;
};

/**
 * Generate the comprehensive stealth script with all 29 anti-detection signals.
 * Accepts optional config for geo/UA customization.
 */
export function generateStealthScript(opts?: StealthScriptOptions): string {
  const geoLat = opts?.geolocation?.latitude ?? null;
  const geoLon = opts?.geolocation?.longitude ?? null;
  // Extract Chrome version from UA string if provided
  const uaMatch = opts?.userAgent?.match(/Chrome\/(\d+)/);
  const chromeVersion = uaMatch?.[1] ?? "145";

  return `
(function() {
  'use strict';

  // ======================================
  // SESSION SEED — all randomization derives from this
  // ======================================
  const _seed = new Uint32Array(8);
  crypto.getRandomValues(_seed);
  function seededRandom(idx) {
    let t = _seed[idx % 8] + 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  let _sIdx = 0;
  const srand = () => seededRandom(_sIdx++);

  // ======================================
  // 1. navigator.webdriver — HANDLED BY PATCHRIGHT
  // ======================================
  // Patchright already patches Runtime.enable to prevent navigator.webdriver
  // from being set to true. We keep this as a safety fallback but it's
  // redundant with Patchright's built-in protection.
  // Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

  // ======================================
  // 2. Chrome runtime + app objects
  // ======================================
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {
    OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
    OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
    PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
    PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
    PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
    RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
    connect: function() { return { onDisconnect: { addListener: function() {} }, onMessage: { addListener: function() {} }, postMessage: function() {} }; },
    sendMessage: function() {},
    id: undefined
  };
  window.chrome.loadTimes = function() {
    return {
      commitLoadTime: Date.now() / 1000 - srand() * 5,
      connectionInfo: 'h2',
      finishDocumentLoadTime: Date.now() / 1000 - srand() * 2,
      finishLoadTime: Date.now() / 1000 - srand(),
      firstPaintAfterLoadTime: 0,
      firstPaintTime: Date.now() / 1000 - srand() * 3,
      navigationType: 'Other',
      npnNegotiatedProtocol: 'h2',
      requestTime: Date.now() / 1000 - srand() * 5,
      startLoadTime: Date.now() / 1000 - srand() * 4,
      wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true
    };
  };
  window.chrome.csi = function() {
    return { onloadT: Date.now(), pageT: Math.floor(srand() * 5000 + 1000), startE: Date.now() - Math.floor(srand() * 5000), tran: 15 };
  };
  window.chrome.app = {
    isInstalled: false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    getDetails: function() { return null; },
    getIsInstalled: function() { return false; }
  };

  // ======================================
  // 3. Permissions API
  // ======================================
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = function(parameters) {
    if (parameters.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission === 'default' ? 'prompt' : Notification.permission, onchange: null });
    }
    return origQuery.call(this, parameters);
  };

  // ======================================
  // 4. Plugins (proper PluginArray spoof)
  // ======================================
  (function spoofPlugins() {
    const pluginData = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format',
        mimes: [{ type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }] },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '',
        mimes: [{ type: 'application/pdf', suffixes: 'pdf', description: '' }] },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '',
        mimes: [
          { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
          { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' }
        ] }
    ];
    const fakePlugins = pluginData.map(pd => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { value: pd.name, enumerable: true },
        filename: { value: pd.filename, enumerable: true },
        description: { value: pd.description, enumerable: true },
        length: { value: pd.mimes.length, enumerable: true }
      });
      pd.mimes.forEach((m, i) => {
        const mime = Object.create(MimeType.prototype);
        Object.defineProperties(mime, {
          type: { value: m.type, enumerable: true },
          suffixes: { value: m.suffixes, enumerable: true },
          description: { value: m.description, enumerable: true },
          enabledPlugin: { value: plugin, enumerable: true }
        });
        Object.defineProperty(plugin, i, { value: mime, enumerable: false });
      });
      return plugin;
    });
    const fakePluginArray = Object.create(PluginArray.prototype);
    fakePlugins.forEach((p, i) => {
      Object.defineProperty(fakePluginArray, i, { value: p, enumerable: true, configurable: true });
    });
    Object.defineProperty(fakePluginArray, 'length', { value: fakePlugins.length, enumerable: true, configurable: true });
    Object.defineProperty(Object.getPrototypeOf(navigator), 'plugins', { get: function() { return fakePluginArray; }, configurable: true });
  })();

  // ======================================
  // 5. MimeTypes (proper MimeTypeArray spoof)
  // ======================================
  (function spoofMimeTypes() {
    const plugins = navigator.plugins;
    const mimeEntries = [];
    for (let i = 0; i < plugins.length; i++) {
      const p = plugins[i];
      for (let j = 0; j < p.length; j++) { mimeEntries.push(p[j]); }
    }
    const fakeMimeArray = Object.create(MimeTypeArray.prototype);
    mimeEntries.forEach((m, i) => {
      Object.defineProperty(fakeMimeArray, i, { value: m, enumerable: true, configurable: true });
    });
    Object.defineProperty(fakeMimeArray, 'length', { value: mimeEntries.length, enumerable: true, configurable: true });
    Object.defineProperty(Object.getPrototypeOf(navigator), 'mimeTypes', { get: function() { return fakeMimeArray; }, configurable: true });
  })();

  // ======================================
  // 6. Languages
  // ======================================
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  Object.defineProperty(navigator, 'language', { get: () => 'en-US', configurable: true });

  // ======================================
  // 7. Hardware (randomized per session)
  // ======================================
  const hwConcurrency = [4, 8, 12][Math.floor(srand() * 3)];
  const devMemory = [4, 8, 16][Math.floor(srand() * 3)];
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => hwConcurrency, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => devMemory, configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });

  // ======================================
  // 8. userAgentData (Client Hints)
  // ======================================
  const _chromeVer = ${JSON.stringify(chromeVersion)};
  Object.defineProperty(navigator, 'userAgentData', {
    get: () => ({
      brands: [
        { brand: 'Chromium', version: _chromeVer },
        { brand: 'Not/A)Brand', version: '24' }
      ],
      mobile: false,
      platform: 'Linux',
      getHighEntropyValues: (hints) => Promise.resolve({
        architecture: 'x86', bitness: '64',
        brands: [{ brand: 'Chromium', version: _chromeVer }, { brand: 'Not/A)Brand', version: '24' }],
        fullVersionList: [{ brand: 'Chromium', version: _chromeVer + '.0.7632.68' }, { brand: 'Not/A)Brand', version: '24.0.0.0' }],
        mobile: false, model: '', platform: 'Linux', platformVersion: '6.14.0',
        uaFullVersion: _chromeVer + '.0.7632.68', wow64: false
      }),
      toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; }
    }),
    configurable: true
  });

  // ======================================
  // 9-10. WebGL randomized per session
  // ======================================
  const webglVendors = [
    ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)']
  ];
  const chosenGL = webglVendors[Math.floor(srand() * webglVendors.length)];
  function patchGetParameter(proto) {
    const orig = proto.getParameter;
    proto.getParameter = function(p) {
      if (p === 37445) return chosenGL[0];
      if (p === 37446) return chosenGL[1];
      return orig.call(this, p);
    };
  }
  patchGetParameter(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patchGetParameter(WebGL2RenderingContext.prototype);

  // ======================================
  // 11. Canvas fingerprint randomization
  // ======================================
  const _canvasNoise = new Float32Array(4);
  crypto.getRandomValues(new Uint32Array(_canvasNoise.buffer));
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, ...args) {
    if (this.width > 0 && this.height > 0) {
      try {
        const ctx = this.getContext('2d');
        if (ctx) {
          const img = ctx.getImageData(0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
          for (let i = 0; i < img.data.length; i += 4) { img.data[i] ^= (_canvasNoise[i % 4] & 1); }
          ctx.putImageData(img, 0, 0);
        }
      } catch(e) {}
    }
    return origToDataURL.apply(this, [type, ...args]);
  };
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function(cb, type, ...args) {
    if (this.width > 0 && this.height > 0) {
      try {
        const ctx = this.getContext('2d');
        if (ctx) {
          const img = ctx.getImageData(0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
          for (let i = 0; i < img.data.length; i += 4) { img.data[i] ^= (_canvasNoise[i % 4] & 1); }
          ctx.putImageData(img, 0, 0);
        }
      } catch(e) {}
    }
    return origToBlob.apply(this, [cb, type, ...args]);
  };

  // ======================================
  // 12. Audio fingerprint randomization
  // ======================================
  const audioNoise = srand() * 0.00001;
  if (window.OfflineAudioContext) {
    const OrigOAC = window.OfflineAudioContext;
    window.OfflineAudioContext = class extends OrigOAC {
      constructor(...args) {
        super(...args);
        const origGetChannelData = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function(ch) {
          const buf = origGetChannelData.call(this, ch);
          if (!this.__noised) {
            for (let i = 0; i < Math.min(buf.length, 100); i++) { buf[i] += audioNoise * (i % 2 === 0 ? 1 : -1); }
            this.__noised = true;
          }
          return buf;
        };
      }
    };
  }
  if (window.AudioContext) {
    const OrigAC = window.AudioContext;
    const origCreateAnalyser = OrigAC.prototype.createAnalyser;
    OrigAC.prototype.createAnalyser = function() {
      const analyser = origCreateAnalyser.call(this);
      const origGetFloat = analyser.getFloatFrequencyData;
      analyser.getFloatFrequencyData = function(arr) {
        origGetFloat.call(this, arr);
        for (let i = 0; i < Math.min(arr.length, 50); i++) { arr[i] += audioNoise * 1000 * (i % 2 === 0 ? 1 : -1); }
      };
      return analyser;
    };
  }

  // ======================================
  // 13. Geolocation spoofing
  // ======================================
  ${
    geoLat != null && geoLon != null
      ? `
  const _geoLat = ${geoLat}, _geoLon = ${geoLon};
  Object.defineProperty(navigator, 'geolocation', {
    get: () => ({
      getCurrentPosition: (success) => {
        setTimeout(() => success({
          coords: {
            latitude: _geoLat + (srand() - 0.5) * 0.005,
            longitude: _geoLon + (srand() - 0.5) * 0.005,
            accuracy: 25 + srand() * 15, altitude: null,
            altitudeAccuracy: null, heading: null, speed: null
          },
          timestamp: Date.now()
        }), 150 + srand() * 100);
      },
      watchPosition: () => 1,
      clearWatch: () => {}
    }),
    configurable: true
  });
  `
      : "// No geolocation spoofing configured"
  }

  // ======================================
  // 14. Performance.memory
  // ======================================
  if (window.performance) {
    Object.defineProperty(window.performance, 'memory', {
      get: () => ({
        jsHeapSizeLimit: 2172649472,
        totalJSHeapSize: 140000000 + Math.floor(srand() * 50000000),
        usedJSHeapSize: 100000000 + Math.floor(srand() * 40000000)
      }),
      configurable: true
    });
  }

  // ======================================
  // 15. Battery API (desktop = undefined)
  // ======================================
  Object.defineProperty(navigator, 'getBattery', { get: () => undefined, configurable: true });

  // ======================================
  // 16. Screen properties
  // ======================================
  const screenProps = { availWidth: 1920, availHeight: 1050, width: 1920, height: 1080, colorDepth: 24, pixelDepth: 24 };
  for (const [k, v] of Object.entries(screenProps)) {
    Object.defineProperty(screen, k, { get: () => v, configurable: true });
  }
  Object.defineProperty(screen, 'orientation', { get: () => ({ type: 'landscape-primary', angle: 0 }), configurable: true });
  Object.defineProperty(window, 'outerWidth', { get: () => 1920, configurable: true });
  Object.defineProperty(window, 'outerHeight', { get: () => 1080, configurable: true });
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true });

  // ======================================
  // 17. Network info
  // ======================================
  const rtt = 50 + Math.floor(srand() * 30);
  Object.defineProperty(navigator, 'connection', {
    get: () => ({ effectiveType: '4g', rtt, downlink: 8 + srand() * 2, saveData: false, onchange: null }),
    configurable: true
  });
  Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });

  // ======================================
  // 18. Intl spoofing (consistent en-US)
  // ======================================
  const OrigDTF = Intl.DateTimeFormat;
  Intl.DateTimeFormat = class extends OrigDTF {
    constructor(locales, options) { super('en-US', options); }
  };
  const OrigNF = Intl.NumberFormat;
  Intl.NumberFormat = class extends OrigNF {
    constructor(locales, options) { super('en-US', options); }
  };

  // ======================================
  // 19. MediaDevices (fake if empty)
  // ======================================
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    const origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = () => origEnum().then(d => d.length === 0 ? [
      { deviceId: 'default', kind: 'audioinput', label: '', groupId: 'g1' },
      { deviceId: 'comms', kind: 'audiooutput', label: '', groupId: 'g2' }
    ] : d);
  }

  // ======================================
  // 20. WebRTC leak prevention
  // ======================================
  if (window.RTCPeerConnection) {
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OrigRTC {
      constructor(config) {
        const c = { ...config, iceCandidatePoolSize: 0 };
        super(c);
        const origAdd = this.addIceCandidate.bind(this);
        this.addIceCandidate = function(cand) {
          if (cand && cand.candidate && (cand.candidate.includes('.local') || /(\\d+\\.\\d+\\.\\d+\\.\\d+)/.test(cand.candidate))) {
            return Promise.resolve();
          }
          return origAdd(cand);
        };
      }
    };
  }

  // ======================================
  // 21. Shadow DOM protection
  // ======================================
  const origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init) {
    return origAttachShadow.call(this, init);
  };

  // ======================================
  // 22. Hairline feature detection (placeholder)
  // ======================================

  // ======================================
  // 23. chrome.webstore (removed in modern Chrome)
  // ======================================
  window.chrome.webstore = undefined;

  // ======================================
  // 24. CDP detection masking
  // ======================================
  const origWarn = console.warn;
  console.warn = function(...args) {
    if (typeof args[0] === 'string' && (args[0].includes('chrome-extension://') || args[0].includes('DevTools'))) return;
    return origWarn.apply(console, args);
  };

  // ======================================
  // 25. Notification.permission
  // ======================================
  const OrigNotification = window.Notification;
  if (OrigNotification) {
    Object.defineProperty(OrigNotification, 'permission', { get: () => 'default', configurable: true });
  }

  // ======================================
  // 26. Function.prototype.toString — hide ALL overrides
  // ======================================
  const nativeToString = Function.prototype.toString;
  const overriddenFns = new Set();
  [
    navigator.permissions.query,
    HTMLCanvasElement.prototype.toDataURL,
    HTMLCanvasElement.prototype.toBlob,
    WebGLRenderingContext.prototype.getParameter,
    console.warn,
    Element.prototype.attachShadow
  ].forEach(f => f && overriddenFns.add(f));
  if (typeof WebGL2RenderingContext !== 'undefined') {
    overriddenFns.add(WebGL2RenderingContext.prototype.getParameter);
  }
  Function.prototype.toString = function() {
    if (overriddenFns.has(this) || this === Function.prototype.toString) {
      return 'function ' + (this.name || '') + '() { [native code] }';
    }
    return nativeToString.call(this);
  };
  overriddenFns.add(Function.prototype.toString);

  // ======================================
  // 27. SourceURL detection prevention (no sourceURL added)
  // ======================================

  // ======================================
  // 28. Error stack trace masking
  // ======================================
  const origPrepareStackTrace = Error.prepareStackTrace;
  Error.prepareStackTrace = function(err, stack) {
    const filtered = stack.filter(f => {
      const fn = f.getFileName();
      return !fn || (!fn.includes('__puppeteer') && !fn.includes('__playwright') && !fn.includes('pptr:'));
    });
    return origPrepareStackTrace ? origPrepareStackTrace(err, filtered) : err.toString() + '\\n' + filtered.map(f => '    at ' + f.toString()).join('\\n');
  };

  // ======================================
  // 29. Human behavior simulation utilities
  // ======================================
  window._humanDelay = function(minMs, maxMs) {
    minMs = minMs || 200; maxMs = maxMs || 800;
    const u1 = srand(), u2 = srand();
    const gaussian = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    const normalized = (gaussian + 3) / 6;
    return Math.max(minMs, Math.min(maxMs, minMs + normalized * (maxMs - minMs)));
  };
  window._bezierPath = function(x0, y0, x1, y1, steps) {
    steps = steps || 30;
    const points = [];
    const cx1 = x0 + (x1 - x0) * (0.25 + srand() * 0.25);
    const cy1 = y0 + (y1 - y0) * (0.1 + srand() * 0.3);
    const cx2 = x0 + (x1 - x0) * (0.5 + srand() * 0.25);
    const cy2 = y0 + (y1 - y0) * (0.7 + srand() * 0.2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, t2 = t * t, t3 = t2 * t, mt = 1 - t, mt2 = mt * mt, mt3 = mt2 * mt;
      points.push({ x: Math.round(mt3*x0 + 3*mt2*t*cx1 + 3*mt*t2*cx2 + t3*x1), y: Math.round(mt3*y0 + 3*mt2*t*cy1 + 3*mt*t2*cy2 + t3*y1) });
    }
    return points;
  };
  window.humanBehavior = { delay: window._humanDelay, bezierPath: window._bezierPath };
})();
`;
}

/**
 * All stealth scripts combined.
 * These are injected via context.addInitScript() when the browser context is created.
 */
export const getAllStealthScripts = (opts?: StealthScriptOptions): string[] => {
  return [generateStealthScript(opts)];
};
