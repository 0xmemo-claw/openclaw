import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";
import { ensurePortAvailable } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import { appendCdpPath } from "./cdp.helpers.js";
import { getHeadersWithAuth, normalizeCdpWsUrl } from "./cdp.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";
import { hasProxyCredentials, startLocalProxyChain, stopAllLocalProxies } from "./proxy-chain.js";

const log = createSubsystemLogger("browser").child("chrome");

// ARM64 detection for GPU workarounds
// Note: Node.js reports ARM64 as "arm64" on all platforms
const isArm64 = process.arch === "arm64";

// Chrome crash signals that indicate profile corruption
const CRASH_SIGNALS = new Set(["SIGTRAP", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGFPE"]);

// Maximum time after launch to consider a crash as "early" (profile corruption indicator)
const EARLY_CRASH_WINDOW_MS = 5000;

// Directories and files to clean when recovering from profile corruption
const PROFILE_CORRUPTION_CLEANUP_TARGETS = [
  "Default/Preferences",
  "Local State",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "BrowserMetrics",
  "Default/IndexedDB",
  "Default/File System",
  "GPUCache",
];

// Chrome singleton files that must be cleaned before launch
const CHROME_SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

export type { BrowserExecutable } from "./chrome.executables.js";
export {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
export {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcessWithoutNullStreams;
};

function resolveBrowserExecutable(resolved: ResolvedBrowserConfig): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(resolved, process.platform);
}

export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

export async function isChromeReachable(cdpUrl: string, timeoutMs = 500): Promise<boolean> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  return Boolean(version);
}

type ChromeVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  "User-Agent"?: string;
};

async function fetchChromeVersion(cdpUrl: string, timeoutMs = 500): Promise<ChromeVersion | null> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, "/json/version");
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: getHeadersWithAuth(versionUrl),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as ChromeVersion;
    if (!data || typeof data !== "object") {
      return null;
    }
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = 500,
): Promise<string | null> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) {
    return null;
  }
  return normalizeCdpWsUrl(wsUrl, cdpUrl);
}

async function canOpenWebSocket(wsUrl: string, timeoutMs = 800): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const headers = getHeadersWithAuth(wsUrl);
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: timeoutMs,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    const timer = setTimeout(
      () => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        resolve(false);
      },
      Math.max(50, timeoutMs + 25),
    );
    ws.once("open", () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = 500,
  handshakeTimeoutMs = 800,
): Promise<boolean> {
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
  if (!wsUrl) {
    return false;
  }
  return await canOpenWebSocket(wsUrl, handshakeTimeoutMs);
}

/**
 * Strip credentials (user:pass@) from a proxy URL.
 * Chrome's --proxy-server flag does not support embedded credentials —
 * passing them causes net::ERR_NO_SUPPORTED_PROXIES.
 * Returns the URL with only scheme://host:port (no trailing slash).
 */
function stripProxyCredentials(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    // Clear credentials and return clean scheme://host:port
    u.username = "";
    u.password = "";
    u.pathname = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    // If URL parsing fails, return as-is and let Chrome deal with it
    return proxyUrl;
  }
}

function expandConfigPath(value: string): string {
  return value
    .replace(/^~(?=\/|$)/, os.homedir())
    .replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => process.env[name] ?? "");
}

function resolveConfiguredExtensionPaths(resolved: ResolvedBrowserConfig): string[] {
  if (!resolved.extensions?.enabled || !Array.isArray(resolved.extensions.paths)) {
    return [];
  }

  const validPaths: string[] = [];
  for (const configuredPath of resolved.extensions.paths) {
    const expandedPath = expandConfigPath(configuredPath).trim();
    if (!expandedPath) {
      continue;
    }
    const manifestPath = path.join(expandedPath, "manifest.json");
    if (!exists(expandedPath) || !exists(manifestPath)) {
      log.warn(
        `Skipping browser extension path (missing directory or manifest.json): ${expandedPath}`,
      );
      continue;
    }
    validPaths.push(expandedPath);
  }

  return validPaths;
}

/**
 * Clean Chrome singleton files that prevent launch after unclean shutdown.
 * These files are left behind when Chrome is killed (e.g., by systemd KillMode=control-group).
 */
function cleanSingletonFiles(userDataDir: string): void {
  for (const singleton of CHROME_SINGLETON_FILES) {
    const singletonPath = path.join(userDataDir, singleton);
    if (exists(singletonPath)) {
      try {
        fs.unlinkSync(singletonPath);
        log.info(`cleaned stale Chrome singleton file: ${singleton}`);
      } catch (err) {
        log.warn(`failed to clean singleton ${singleton}: ${String(err)}`);
      }
    }
  }
}

/**
 * Clean Chromium crash reports that accumulate during crash loops.
 * Returns the number of files cleaned.
 */
function cleanCrashReports(): number {
  const crashReportsDir = path.join(
    os.homedir(),
    ".config",
    "chromium",
    "Crash Reports",
    "pending",
  );
  if (!exists(crashReportsDir)) {
    return 0;
  }
  let cleaned = 0;
  try {
    const files = fs.readdirSync(crashReportsDir);
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(crashReportsDir, f));
        cleaned++;
      } catch {
        // ignore individual file failures
      }
    }
    if (cleaned > 0) {
      log.info(`cleaned ${cleaned} Chromium crash report(s)`);
    }
  } catch {
    // ignore directory read failures
  }
  return cleaned;
}

/**
 * Nuke profile directories that commonly get corrupted during crash loops.
 * This is called when Chrome crashes early (within EARLY_CRASH_WINDOW_MS) with a crash signal.
 */
function nukeCorruptedProfileData(userDataDir: string): void {
  log.warn(`nuking potentially corrupted profile data in ${userDataDir}`);

  for (const target of PROFILE_CORRUPTION_CLEANUP_TARGETS) {
    const targetPath = path.join(userDataDir, target);
    if (exists(targetPath)) {
      try {
        fs.rmSync(targetPath, { recursive: true, force: true });
        log.info(`removed corrupted profile data: ${target}`);
      } catch (err) {
        log.warn(`failed to remove ${target}: ${String(err)}`);
      }
    }
  }
}

export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  // === Pre-launch cleanup for robustness ===
  // Clean stale singleton files from unclean shutdown (e.g., systemd KillMode=control-group)
  cleanSingletonFiles(userDataDir);
  // Clean accumulated crash reports from crash loops
  cleanCrashReports();

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
  );

  // Start local proxy-chain if upstream proxy has credentials
  // This must happen before spawnOnce() is called
  let proxyUrlForChrome: string | undefined;
  if (resolved.stealth.proxy?.url) {
    if (hasProxyCredentials(resolved.stealth.proxy.url)) {
      proxyUrlForChrome = await startLocalProxyChain(resolved.stealth.proxy.url);
    } else {
      proxyUrlForChrome = stripProxyCredentials(resolved.stealth.proxy.url);
    }
  }

  // Resolve extension paths from browser.extensions config.
  const extensionPaths = resolveConfiguredExtensionPaths(resolved);

  // First launch to create preference files if missing, then decorate and relaunch.
  const spawnOnce = () => {
    const args: string[] = [
      `--remote-debugging-port=${profile.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--password-store=basic",
    ];

    // === Stealth flags ===
    if (resolved.stealth.enabled) {
      args.push(
        "--disable-infobars",
        // Keep extensions enabled when custom unpacked extensions are configured.
        ...(extensionPaths.length > 0 ? [] : ["--disable-extensions"]),
        "--disable-preconnect",
        "--disable-default-apps",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-client-side-phishing-detection",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--lang=en-US,en",
        "--window-size=1920,1080",
        "--force-device-scale-factor=1",
        "--force-color-profile=srgb",
      );

      // ARM64: SwiftShader is less stable on aarch64 and can cause SIGTRAP crashes.
      // Fall back to disabling GPU entirely instead of software rendering.
      // See: ContextResult::kTransientFailure in GPU process logs.
      if (isArm64) {
        args.push("--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu");
        log.info("ARM64 detected: using --disable-gpu instead of SwiftShader for stability");
      } else {
        args.push("--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader-webgl");
      }

      args.push(
        "--enable-features=NetworkService,NetworkServiceInProcess",
        "--disable-features=IsolateOrigins,site-per-process,TranslateUI",
      );
    }

    // === Proxy flags ===
    if (proxyUrlForChrome) {
      args.push(`--proxy-server=${proxyUrlForChrome}`);
      if (resolved.stealth.proxy?.bypassList?.length) {
        args.push(`--proxy-bypass-list=${resolved.stealth.proxy.bypassList.join(";")}`);
      }
    }

    // === Custom user agent ===
    if (resolved.stealth.userAgent) {
      args.push(`--user-agent=${resolved.stealth.userAgent}`);
    }

    // === Extension loading ===
    if (extensionPaths.length > 0) {
      const extensionArg = extensionPaths.join(",");
      args.push(`--disable-extensions-except=${extensionArg}`);
      args.push(`--load-extension=${extensionArg}`);
      log.info(`Loading unpacked Chrome extensions: ${extensionArg}`);
    }

    if (resolved.headless) {
      // Best-effort; older Chromes may ignore.
      args.push("--headless=new");
      args.push("--disable-gpu");
    }
    if (resolved.noSandbox) {
      args.push("--no-sandbox");
      args.push("--disable-setuid-sandbox");
    }
    if (process.platform === "linux") {
      args.push("--disable-dev-shm-usage");
    }

    // Stealth: hide navigator.webdriver from automation detection (#80)
    args.push("--disable-blink-features=AutomationControlled");

    // Append user-configured extra arguments (e.g., stealth flags, window size)
    if (resolved.extraArgs.length > 0) {
      args.push(...resolved.extraArgs);
    }

    // Always open a blank tab to ensure a target exists.
    args.push("about:blank");

    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Reduce accidental sharing with the user's env.
      HOME: os.homedir(),
    };
    // Ensure DISPLAY is set for headless Chrome on Linux
    if (process.platform === "linux" && !spawnEnv.DISPLAY) {
      spawnEnv.DISPLAY = ":99";
    }
    return spawn(exe.path, args, {
      stdio: "pipe",
      env: spawnEnv,
    });
  };

  const startedAt = Date.now();

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  // If the profile doesn't exist yet, bootstrap it once so Chrome creates defaults.
  // Then decorate (if needed) before the "real" run.
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
      });
      log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
    }
  }

  try {
    ensureProfileCleanExit(userDataDir);
  } catch (err) {
    log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
  }

  // Launch with corruption recovery - if Chrome crashes early with a crash signal,
  // nuke the profile and retry once.
  let proc = spawnOnce();
  let procStartedAt = Date.now();
  let earlyCrashDetected = false;
  let earlyCrashSignal: string | null = null;

  // Set up early crash detection
  const onEarlyExit = (code: number | null, signal: string | null) => {
    const uptime = Date.now() - procStartedAt;
    if (uptime < EARLY_CRASH_WINDOW_MS && signal && CRASH_SIGNALS.has(signal)) {
      earlyCrashDetected = true;
      earlyCrashSignal = signal;
      log.warn(`Chrome crashed on launch (${signal} after ${uptime}ms) — likely corrupted profile`);
    }
  };
  proc.once("exit", onEarlyExit);

  // Wait for CDP to come up.
  let readyDeadline = Date.now() + 30_000;
  while (Date.now() < readyDeadline) {
    // Check if Chrome crashed early
    if (earlyCrashDetected) {
      break;
    }
    if (await isChromeReachable(profile.cdpUrl, 500)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // === Corruption recovery ===
  // If Chrome crashed early with a crash signal, nuke profile and retry once
  if (earlyCrashDetected) {
    log.warn(`attempting profile corruption recovery for "${profile.name}"`);

    // Nuke corrupted profile data
    nukeCorruptedProfileData(userDataDir);
    cleanCrashReports();

    // Re-apply clean exit prefs (will be regenerated on bootstrap)
    const localStatePath = path.join(userDataDir, "Local State");
    const preferencesPath = path.join(userDataDir, "Default", "Preferences");
    const needsRebootstrap = !exists(localStatePath) || !exists(preferencesPath);

    if (needsRebootstrap) {
      // Re-bootstrap profile
      const bootstrap = spawnOnce();
      const bootstrapDeadline = Date.now() + 10_000;
      while (Date.now() < bootstrapDeadline) {
        if (exists(localStatePath) && exists(preferencesPath)) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      try {
        bootstrap.kill("SIGTERM");
      } catch {
        // ignore
      }
      const exitDeadline = Date.now() + 5000;
      while (Date.now() < exitDeadline) {
        if (bootstrap.exitCode != null) {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      // Re-decorate if needed
      if (needsDecorate) {
        try {
          decorateOpenClawProfile(userDataDir, {
            name: profile.name,
            color: profile.color,
          });
        } catch {
          // ignore decoration failures on recovery
        }
      }
    }

    try {
      ensureProfileCleanExit(userDataDir);
    } catch {
      // ignore
    }

    // Retry launch
    log.info(`retrying Chrome launch after profile recovery for "${profile.name}"`);
    proc = spawnOnce();
    procStartedAt = Date.now();
    earlyCrashDetected = false;
    proc.once("exit", (code, signal) => {
      const uptime = Date.now() - procStartedAt;
      if (uptime < EARLY_CRASH_WINDOW_MS && signal && CRASH_SIGNALS.has(signal)) {
        log.error(
          `Chrome crashed again after profile recovery (${signal} after ${uptime}ms) — giving up`,
        );
      }
    });

    // Wait for CDP again
    readyDeadline = Date.now() + 30_000;
    while (Date.now() < readyDeadline) {
      if (await isChromeReachable(profile.cdpUrl, 500)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!(await isChromeReachable(profile.cdpUrl, 500))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    const crashHint = earlyCrashSignal ? ` (crashed with ${String(earlyCrashSignal)})` : "";
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".${crashHint}`,
    );
  }

  const pid = proc.pid ?? -1;
  log.info(
    `🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
  );

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
  };
}

export async function stopOpenClawChrome(running: RunningChrome, timeoutMs = 2500) {
  const proc = running.proc;
  if (proc.killed) {
    return;
  }

  // Stop any local proxy-chain servers we started
  await stopAllLocalProxies().catch(() => {});

  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!proc.exitCode && proc.killed) {
      break;
    }
    if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), 200))) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
