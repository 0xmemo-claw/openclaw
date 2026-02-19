/**
 * Local proxy server that forwards to an upstream proxy with authentication.
 *
 * Chrome's --proxy-server flag does NOT support embedded credentials
 * (e.g., http://user:pass@host:port causes ERR_NO_SUPPORTED_PROXIES).
 *
 * This module uses proxy-chain to create a local proxy without authentication
 * that forwards requests to the real upstream proxy WITH authentication.
 *
 * Flow:
 *   Chrome → local proxy (no auth) → upstream proxy (with auth) → target
 */

import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";
import { ensurePortAvailable } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("proxy-chain");

/** Active anonymized proxy URLs and their original URLs */
const activeProxies = new Map<string, string>();

/**
 * Start a local proxy that forwards to an upstream proxy with authentication.
 *
 * @param upstreamProxyUrl - The upstream proxy URL with embedded credentials
 * @returns The local proxy URL (without credentials) that Chrome should use
 */
export async function startLocalProxyChain(upstreamProxyUrl: string): Promise<string> {
  // Check if we already have an active proxy for this URL
  for (const [localUrl, originalUrl] of activeProxies) {
    if (originalUrl === upstreamProxyUrl) {
      log.info(`Reusing existing local proxy: ${localUrl}`);
      return localUrl;
    }
  }

  // Find an available port for the local proxy
  const port = await findAvailablePort(12000, 12500);

  log.info(`Starting local proxy on port ${port} → ${redactCredentials(upstreamProxyUrl)}`);

  // Use proxy-chain's anonymizeProxy to create a local proxy
  const localProxyUrl = await anonymizeProxy({
    url: upstreamProxyUrl,
    port,
  });

  activeProxies.set(localProxyUrl, upstreamProxyUrl);

  log.info(`Local proxy chain started: ${localProxyUrl}`);

  return localProxyUrl;
}

/**
 * Stop all local proxy servers.
 */
export async function stopAllLocalProxies(): Promise<void> {
  const urls = Array.from(activeProxies.keys());
  activeProxies.clear();

  for (const url of urls) {
    try {
      log.info(`Stopping local proxy: ${url}`);
      await closeAnonymizedProxy(url, true);
    } catch (err) {
      log.warn(`Error stopping local proxy ${url}: ${String(err)}`);
    }
  }
}

/**
 * Stop a specific local proxy server.
 */
export async function stopLocalProxy(localProxyUrl: string): Promise<boolean> {
  if (!activeProxies.has(localProxyUrl)) {
    return false;
  }

  activeProxies.delete(localProxyUrl);

  try {
    log.info(`Stopping local proxy: ${localProxyUrl}`);
    return await closeAnonymizedProxy(localProxyUrl, true);
  } catch (err) {
    log.warn(`Error stopping local proxy ${localProxyUrl}: ${String(err)}`);
    return false;
  }
}

/**
 * Check if a proxy URL has embedded credentials.
 */
export function hasProxyCredentials(proxyUrl: string): boolean {
  try {
    const u = new URL(proxyUrl);
    return Boolean(u.username);
  } catch {
    return false;
  }
}

/**
 * Redact credentials from a proxy URL for logging.
 */
function redactCredentials(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    if (u.username) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return proxyUrl;
  }
}

/**
 * Find an available port in the given range.
 */
async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    try {
      await ensurePortAvailable(port);
      return port;
    } catch {
      // Port is in use, try next
    }
  }
  throw new Error(`No available port in range ${start}-${end}`);
}
