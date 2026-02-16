import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBrowserConfig } from "./config.js";
import { ensureBrowserControlAuth } from "./control-auth.js";
import { ensureChromeExtensionRelayServer } from "./extension-relay.js";
import { setStealthOptions } from "./pw-session.js";
import { type BrowserServerState, createBrowserRouteContext } from "./server-context.js";
import { ensureExtensionRelayForProfiles, stopKnownBrowserProfiles } from "./server-lifecycle.js";

let state: BrowserServerState | null = null;
const log = createSubsystemLogger("browser");
const logService = log.child("service");

export function getBrowserControlState(): BrowserServerState | null {
  return state;
}

export function createBrowserControlContext() {
  return createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
  });
}

export function getCaptchaSolverConfig(): {
  provider: "2captcha" | "capsolver";
  apiKey: string;
} | null {
  if (!state?.resolved.stealth.captcha) {
    return null;
  }
  const { provider, apiKey } = state.resolved.stealth.captcha;
  if (!provider || !apiKey) {
    return null;
  }
  return { provider, apiKey };
}

export async function startBrowserControlServiceFromConfig(): Promise<BrowserServerState | null> {
  if (state) {
    return state;
  }

  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  if (!resolved.enabled) {
    return null;
  }

  // Auto-derive geolocation from proxy IP if not explicitly configured
  if (resolved.stealth.enabled && !resolved.stealth.geolocation && resolved.stealth.proxy?.url) {
    try {
      const { execSync } = await import("node:child_process");
      const proxyUrl = resolved.stealth.proxy.url;
      const ip = execSync(
        `curl -s --proxy ${JSON.stringify(proxyUrl)} --max-time 5 https://api.ipify.org`,
        {
          encoding: "utf-8",
          timeout: 8000,
        },
      ).trim();
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        const info = JSON.parse(
          execSync(`curl -s --max-time 5 https://ipinfo.io/${ip}/json`, {
            encoding: "utf-8",
            timeout: 8000,
          }),
        );
        if (info.loc) {
          const [lat, lng] = info.loc.split(",").map(Number);
          resolved.stealth.geolocation = { latitude: lat, longitude: lng };
          logService.info(
            `Auto-derived geolocation from proxy IP ${ip}: ${info.city ?? ""} (${lat}, ${lng})`,
          );
        }
      }
    } catch (err) {
      logService.warn(`Failed to auto-derive geolocation: ${String(err)}`);
    }
  }

  // Configure stealth script options from resolved config
  if (resolved.stealth.enabled) {
    let geo = resolved.stealth.geolocation;

    // Auto-derive geolocation from proxy IP if no explicit geo configured
    if (!geo && resolved.stealth.proxy?.url) {
      try {
        geo = await deriveGeoFromProxy(resolved.stealth.proxy.url);
        if (geo) {
          logService.info(
            `Stealth: auto-derived geolocation from proxy → ${geo.city ?? "unknown"} (${geo.latitude}, ${geo.longitude})`,
          );
        }
      } catch (err) {
        logService.warn(`Stealth: failed to derive geo from proxy: ${String(err)}`);
      }
    }

    // If still no geo, derive from local machine IP
    if (!geo) {
      try {
        geo = await deriveGeoFromLocalIp();
        if (geo) {
          logService.info(
            `Stealth: using local IP geolocation → ${geo.city ?? "unknown"} (${geo.latitude}, ${geo.longitude})`,
          );
        }
      } catch (err) {
        logService.warn(`Stealth: failed to derive local geo: ${String(err)}`);
      }
    }

    setStealthOptions({
      geolocation: geo,
      userAgent: resolved.stealth.userAgent,
    });
  }
  try {
    const ensured = await ensureBrowserControlAuth({ cfg });
    if (ensured.generatedToken) {
      logService.info("No browser auth configured; generated gateway.auth.token automatically.");
    }
  } catch (err) {
    logService.warn(`failed to auto-configure browser auth: ${String(err)}`);
  }

  state = {
    server: null,
    port: resolved.controlPort,
    resolved,
    profiles: new Map(),
  };

  await ensureExtensionRelayForProfiles({
    resolved,
    onWarn: (message) => logService.warn(message),
  });

  logService.info(
    `Browser control service ready (profiles=${Object.keys(resolved.profiles).length})`,
  );

  // Eagerly spawn browser on startup so it's ready for VNC/automation
  if (resolved.enabled) {
    const ctx = createBrowserRouteContext({
      getState: () => state,
      refreshConfigFromDisk: false,
    });
    ctx
      .ensureBrowserAvailable()
      .then(() => {
        logService.info("Browser auto-started on boot");
      })
      .catch((err) => {
        logService.warn(`Browser auto-start failed: ${String(err)}`);
      });
  }

  return state;
}

type GeoResult = { latitude: number; longitude: number; city?: string };

async function fetchGeoForIp(ip?: string): Promise<GeoResult | undefined> {
  const url = ip ? `https://ipinfo.io/${ip}/json` : "https://ipinfo.io/json";
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      return undefined;
    }
    const data = (await res.json()) as { loc?: string; city?: string };
    if (!data.loc) {
      return undefined;
    }
    const [lat, lon] = data.loc.split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return undefined;
    }
    return { latitude: lat, longitude: lon, city: data.city };
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

async function deriveGeoFromProxy(proxyUrl: string): Promise<GeoResult | undefined> {
  // Get the external IP through the proxy
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), 8000);
  clearTimeout(t);

  // Simpler: extract host from proxy URL, but that's localhost.
  // Best approach: shell out to curl through the proxy.
  try {
    const { execSync } = await import("node:child_process");
    const ip = execSync(`curl -s --proxy ${proxyUrl} --max-time 5 https://api.ipify.org`, {
      encoding: "utf-8",
      timeout: 8000,
    }).trim();
    if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      return undefined;
    }
    return fetchGeoForIp(ip);
  } catch {
    return undefined;
  }
}

async function deriveGeoFromLocalIp(): Promise<GeoResult | undefined> {
  return fetchGeoForIp();
}

export async function stopBrowserControlService(): Promise<void> {
  const current = state;
  if (!current) {
    return;
  }

  await stopKnownBrowserProfiles({
    getState: () => state,
    onWarn: (message) => logService.warn(message),
  });

  state = null;

  // Optional: Playwright is not always available (e.g. embedded gateway builds).
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch {
    // ignore
  }
}
