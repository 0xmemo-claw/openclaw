import fs from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import type { TlsOptions } from "node:tls";
import { fileURLToPath } from "node:url";
import type { WebSocketServer } from "ws";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../browser/control-service.js";
import {
  A2UI_PATH,
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  handleA2uiHttpRequest,
} from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { loadConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { handleSlackHttpRequest } from "../slack/http/index.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeGatewayConnect,
  isLocalDirectRequest,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import {
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
  type ControlUiRootState,
} from "./control-ui.js";
import { applyHookMappings } from "./hooks-mapping.js";
import {
  extractHookToken,
  getHookAgentPolicyError,
  getHookChannelError,
  type HookMessageChannel,
  type HooksConfigResolved,
  isHookAgentAllowed,
  normalizeAgentPayload,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
  resolveHookChannel,
  resolveHookDeliver,
} from "./hooks.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import { isPrivateOrLoopbackAddress, resolveGatewayClientIp } from "./net.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";
import { attachVncProxy } from "./vnc-proxy.js";
import { VNC_VIEWER_HTML } from "./vnc-viewer.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;
type HookAuthFailure = { count: number; windowStartedAtMs: number };

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;
const HOOK_AUTH_FAILURE_TRACK_MAX = 2048;

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: {
    message: string;
    name: string;
    agentId?: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
  }) => string;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function isCanvasPath(pathname: string): boolean {
  return (
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`) ||
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === CANVAS_WS_PATH
  );
}

function hasAuthorizedWsClientForIp(clients: Set<GatewayWsClient>, clientIp: string): boolean {
  for (const client of clients) {
    if (client.clientIp && client.clientIp === clientIp) {
      return true;
    }
  }
  return false;
}

function resolveVncRoutePath(controlUiBasePath: string, suffix = ""): string {
  const base = controlUiBasePath ? `${controlUiBasePath}/vnc` : "/vnc";
  return `${base}${suffix}`;
}

function resolveBundledNoVncRoot(): string | null {
  // Prefer vendor/novnc/core (ESM source, browser-compatible) over npm package (CJS)
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "vendor", "novnc"),
    path.resolve(process.cwd(), "vendor", "novnc"),
    path.resolve(process.cwd(), "node_modules", "@novnc", "novnc"),
    path.resolve(moduleDir, "..", "..", "node_modules", "@novnc", "novnc"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

function isSafeNoVncAssetPath(rel: string): boolean {
  if (!rel || rel.includes("\0")) {
    return false;
  }
  const normalized = path.posix.normalize(rel);
  return !(normalized.startsWith("../") || normalized === "..");
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ttf":
      return "font/ttf";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function authorizeMachineScopedRequest(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  clients: Set<GatewayWsClient>;
  rateLimiter?: AuthRateLimiter;
}): Promise<GatewayAuthResult> {
  const { req, auth, trustedProxies, clients, rateLimiter } = params;
  if (isLocalDirectRequest(req, trustedProxies)) {
    return { ok: true };
  }

  let lastAuthFailure: GatewayAuthResult | null = null;
  const token = getBearerToken(req);
  if (token) {
    const authResult = await authorizeGatewayConnect({
      auth: { ...auth, allowTailscale: false },
      connectAuth: { token, password: token },
      req,
      trustedProxies,
      rateLimiter,
    });
    if (authResult.ok) {
      return authResult;
    }
    lastAuthFailure = authResult;
  }

  const clientIp = resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: getHeader(req, "x-forwarded-for"),
    realIp: getHeader(req, "x-real-ip"),
    trustedProxies,
  });
  if (!clientIp) {
    return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
  }

  // IP-based fallback is only safe for machine-scoped addresses.
  // Only allow IP-based fallback for private/loopback addresses to prevent
  // cross-session access in shared-IP environments (corporate NAT, cloud).
  if (!isPrivateOrLoopbackAddress(clientIp)) {
    return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
  }
  if (hasAuthorizedWsClientForIp(clients, clientIp)) {
    return { ok: true };
  }
  return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
}

function writeUpgradeAuthFailure(
  socket: { write: (chunk: string) => void },
  auth: GatewayAuthResult,
) {
  if (auth.rateLimited) {
    const retryAfterSeconds =
      auth.retryAfterMs && auth.retryAfterMs > 0 ? Math.ceil(auth.retryAfterMs / 1000) : undefined;
    socket.write(
      [
        "HTTP/1.1 429 Too Many Requests",
        retryAfterSeconds ? `Retry-After: ${retryAfterSeconds}` : undefined,
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        JSON.stringify({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        }),
      ]
        .filter(Boolean)
        .join("\r\n"),
    );
    return;
  }
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, bindHost, port, logHooks, dispatchAgentHook, dispatchWakeHook } = opts;
  const hookAuthFailures = new Map<string, HookAuthFailure>();

  const resolveHookClientKey = (req: IncomingMessage): string => {
    return req.socket?.remoteAddress?.trim() || "unknown";
  };

  const recordHookAuthFailure = (
    clientKey: string,
    nowMs: number,
  ): { throttled: boolean; retryAfterSeconds?: number } => {
    if (!hookAuthFailures.has(clientKey) && hookAuthFailures.size >= HOOK_AUTH_FAILURE_TRACK_MAX) {
      // Prune expired entries instead of clearing all state.
      for (const [key, entry] of hookAuthFailures) {
        if (nowMs - entry.windowStartedAtMs >= HOOK_AUTH_FAILURE_WINDOW_MS) {
          hookAuthFailures.delete(key);
        }
      }
      // If still at capacity after pruning, drop the oldest half.
      if (hookAuthFailures.size >= HOOK_AUTH_FAILURE_TRACK_MAX) {
        let toRemove = Math.floor(hookAuthFailures.size / 2);
        for (const key of hookAuthFailures.keys()) {
          if (toRemove <= 0) {
            break;
          }
          hookAuthFailures.delete(key);
          toRemove--;
        }
      }
    }
    const current = hookAuthFailures.get(clientKey);
    const expired = !current || nowMs - current.windowStartedAtMs >= HOOK_AUTH_FAILURE_WINDOW_MS;
    const next: HookAuthFailure = expired
      ? { count: 1, windowStartedAtMs: nowMs }
      : { count: current.count + 1, windowStartedAtMs: current.windowStartedAtMs };
    // Delete-before-set refreshes Map insertion order so recently-active
    // clients are not evicted before dormant ones during oldest-half eviction.
    if (hookAuthFailures.has(clientKey)) {
      hookAuthFailures.delete(clientKey);
    }
    hookAuthFailures.set(clientKey, next);
    if (next.count <= HOOK_AUTH_FAILURE_LIMIT) {
      return { throttled: false };
    }
    const retryAfterMs = Math.max(1, next.windowStartedAtMs + HOOK_AUTH_FAILURE_WINDOW_MS - nowMs);
    return {
      throttled: true,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  };

  const clearHookAuthFailure = (clientKey: string) => {
    hookAuthFailures.delete(clientKey);
  };

  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    const url = new URL(req.url ?? "/", `http://${bindHost}:${port}`);
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).",
      );
      return true;
    }

    const token = extractHookToken(req);
    const clientKey = resolveHookClientKey(req);
    if (!safeEqualSecret(token, hooksConfig.token)) {
      const throttle = recordHookAuthFailure(clientKey, Date.now());
      if (throttle.throttled) {
        const retryAfter = throttle.retryAfterSeconds ?? 1;
        res.statusCode = 429;
        res.setHeader("Retry-After", String(retryAfter));
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Too Many Requests");
        logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
        return true;
      }
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    clearHookAuthFailure(clientKey);

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status =
        body.error === "payload too large"
          ? 413
          : body.error === "request body timeout"
            ? 408
            : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
        sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
        return true;
      }
      const sessionKey = resolveHookSessionKey({
        hooksConfig,
        source: "request",
        sessionKey: normalized.value.sessionKey,
      });
      if (!sessionKey.ok) {
        sendJson(res, 400, { ok: false, error: sessionKey.error });
        return true;
      }
      const runId = dispatchAgentHook({
        ...normalized.value,
        sessionKey: sessionKey.value,
        agentId: resolveHookTargetAgentId(hooksConfig, normalized.value.agentId),
      });
      sendJson(res, 202, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
            sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
            return true;
          }
          const sessionKey = resolveHookSessionKey({
            hooksConfig,
            source: "mapping",
            sessionKey: mapped.action.sessionKey,
          });
          if (!sessionKey.ok) {
            sendJson(res, 400, { ok: false, error: sessionKey.error });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            agentId: resolveHookTargetAgentId(hooksConfig, mapped.action.agentId),
            wakeMode: mapped.action.wakeMode,
            sessionKey: sessionKey.value,
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
          });
          sendJson(res, 202, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

export function createGatewayHttpServer(opts: {
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  vncEnabled: boolean;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: HooksRequestHandler;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  tlsOptions?: TlsOptions;
}): HttpServer {
  const {
    canvasHost,
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    vncEnabled,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    handleHooksRequest,
    handlePluginRequest,
    resolvedAuth,
    rateLimiter,
  } = opts;
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequest(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequest(req, res);
      });
  const vncViewerPath = resolveVncRoutePath(controlUiBasePath);
  const vncApiPrefix = resolveVncRoutePath(controlUiBasePath, "/api/");
  const vncAssetsPrefix = resolveVncRoutePath(controlUiBasePath, "/novnc/");
  const noVncRoot = vncEnabled ? resolveBundledNoVncRoot() : null;

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    try {
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
      if (await handleHooksRequest(req, res)) {
        return;
      }
      if (
        await handleToolsInvokeHttpRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
          rateLimiter,
        })
      ) {
        return;
      }
      if (await handleSlackHttpRequest(req, res)) {
        return;
      }
      if (handlePluginRequest) {
        // Channel HTTP endpoints are gateway-auth protected by default.
        // Non-channel plugin routes remain plugin-owned and must enforce
        // their own auth when exposing sensitive functionality.
        if (requestPath.startsWith("/api/channels/")) {
          const token = getBearerToken(req);
          const authResult = await authorizeGatewayConnect({
            auth: resolvedAuth,
            connectAuth: token ? { token, password: token } : null,
            req,
            trustedProxies,
            rateLimiter,
          });
          if (!authResult.ok) {
            sendGatewayAuthFailure(res, authResult);
            return;
          }
        }
        if (await handlePluginRequest(req, res)) {
          return;
        }
      }
      if (openResponsesEnabled) {
        if (
          await handleOpenResponsesHttpRequest(req, res, {
            auth: resolvedAuth,
            config: openResponsesConfig,
            trustedProxies,
            rateLimiter,
          })
        ) {
          return;
        }
      }
      if (openAiChatCompletionsEnabled) {
        if (
          await handleOpenAiHttpRequest(req, res, {
            auth: resolvedAuth,
            trustedProxies,
            rateLimiter,
          })
        ) {
          return;
        }
      }
      if (
        vncEnabled &&
        (requestPath === vncViewerPath ||
          requestPath === `${vncViewerPath}/` ||
          requestPath.startsWith(vncApiPrefix) ||
          requestPath.startsWith(vncAssetsPrefix))
      ) {
        const ok = await authorizeMachineScopedRequest({
          req,
          auth: resolvedAuth,
          trustedProxies,
          clients,
          rateLimiter,
        });
        if (!ok.ok) {
          sendGatewayAuthFailure(res, ok);
          return;
        }

        if (requestPath === vncViewerPath) {
          // Redirect /vnc to /vnc/ so relative imports resolve correctly
          const qs = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
          res.writeHead(301, { Location: `${vncViewerPath}/${qs}` });
          res.end();
          return;
        }
        if (requestPath === `${vncViewerPath}/`) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(VNC_VIEWER_HTML);
          return;
        }

        // Browser control API: /vnc/api/{status,start,stop,restart}
        if (requestPath.startsWith(vncApiPrefix)) {
          const action = requestPath.slice(vncApiPrefix.length).replace(/\/+$/, "");
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          try {
            if (action === "status") {
              const st = getBrowserControlState();
              // Extract runtime info from the default/openclaw profile
              const profileState = st
                ? (st.profiles.get("openclaw") ?? st.profiles.values().next().value ?? null)
                : null;
              const chrome = profileState?.running ?? null;
              const resolved = st?.resolved;
              const stealth = resolved?.stealth;
              res.statusCode = 200;
              res.end(
                JSON.stringify({
                  running: !!chrome,
                  pid: chrome?.pid ?? null,
                  cdpPort: chrome?.cdpPort ?? null,
                  tabs: 0, // populated below if cdp is reachable
                  stealth: stealth
                    ? {
                        enabled: stealth.enabled,
                        proxy: !!stealth.proxy?.url,
                        proxyUrl: stealth.proxy?.url
                          ? stealth.proxy.url.replace(/:[^:@]+@/, ":***@")
                          : null,
                        userAgent: stealth.userAgent ?? null,
                        captcha: stealth.captcha
                          ? {
                              provider: stealth.captcha.provider,
                              configured: !!stealth.captcha.apiKey,
                            }
                          : null,
                        geolocation: stealth.geolocation ?? null,
                      }
                    : null,
                }),
              );
            } else if (action === "restart" && req.method === "POST") {
              await stopBrowserControlService();
              await startBrowserControlServiceFromConfig();
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true, starting: true }));
              try {
                const ctx = createBrowserControlContext();
                await ctx.ensureBrowserAvailable();
              } catch {
                // Client will see the error via status polling
              }
            } else if (action === "stop" && req.method === "POST") {
              await stopBrowserControlService();
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true, running: false }));
            } else if (action === "start" && req.method === "POST") {
              await startBrowserControlServiceFromConfig();
              // Respond immediately, spawn Chrome in background
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true, starting: true }));
              try {
                const ctx = createBrowserControlContext();
                await ctx.ensureBrowserAvailable();
              } catch {
                // Client will see the error via status polling
              }
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "Unknown action" }));
            }
          } catch (err: unknown) {
            res.statusCode = 500;
            res.end(
              JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
            );
          }
          return;
        }

        if (!noVncRoot) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("noVNC assets missing. Install dependencies with `pnpm install`.");
          return;
        }

        const rel = requestPath.slice(vncAssetsPrefix.length);
        if (!isSafeNoVncAssetPath(rel)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
          return;
        }

        const filePath = path.join(noVncRoot, rel);
        if (!filePath.startsWith(noVncRoot)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
          return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", contentTypeForPath(filePath));
        res.setHeader("Cache-Control", "public, max-age=300");
        res.end(fs.readFileSync(filePath));
        return;
      }
      if (canvasHost) {
        if (isCanvasPath(requestPath)) {
          const ok = await authorizeMachineScopedRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            clients,
            rateLimiter,
          });
          if (!ok.ok) {
            sendGatewayAuthFailure(res, ok);
            return;
          }
        }
        if (await handleA2uiHttpRequest(req, res)) {
          return;
        }
        if (await canvasHost.handleHttpRequest(req, res)) {
          return;
        }
      }
      if (controlUiEnabled) {
        if (
          handleControlUiAvatarRequest(req, res, {
            basePath: controlUiBasePath,
            resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId),
          })
        ) {
          return;
        }
        if (
          handleControlUiHttpRequest(req, res, {
            basePath: controlUiBasePath,
            config: configSnapshot,
            root: controlUiRoot,
          })
        ) {
          return;
        }
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  vncWss: WebSocketServer | null;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiBasePath: string;
  vncEnabled: boolean;
  vncPort: number;
  vncLog?: SubsystemLogger;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
}) {
  const {
    httpServer,
    wss,
    vncWss,
    canvasHost,
    clients,
    controlUiBasePath,
    vncEnabled,
    vncPort,
    vncLog,
    resolvedAuth,
    rateLimiter,
  } = opts;
  const vncWsPath = resolveVncRoutePath(controlUiBasePath, "/ws");
  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      if (vncEnabled && url.pathname === vncWsPath) {
        // No extra auth — gateway already gates /vnc/* access
        (vncWss ?? wss).handleUpgrade(req, socket, head, (ws) => {
          attachVncProxy(ws, req, {
            vncPort,
            log:
              vncLog ??
              ({
                debug: () => {},
                info: () => {},
                warn: () => {},
                error: () => {},
              } as SubsystemLogger),
          });
        });
        return;
      }

      if (canvasHost) {
        if (url.pathname === CANVAS_WS_PATH) {
          const ok = await authorizeMachineScopedRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            clients,
            rateLimiter,
          });
          if (!ok.ok) {
            writeUpgradeAuthFailure(socket, ok);
            socket.destroy();
            return;
          }
        }
        if (canvasHost.handleUpgrade(req, socket, head)) {
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    })().catch(() => {
      socket.destroy();
    });
  });
}
