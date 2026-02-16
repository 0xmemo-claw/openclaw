import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createConnection, type Socket } from "node:net";
import type { createSubsystemLogger } from "../logging/subsystem.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type VncProxyConfig = {
  vncHost?: string;
  vncPort: number;
  log: SubsystemLogger;
};

/**
 * Bridge a WebSocket connection to a VNC TCP server (e.g. x11vnc on port 5900).
 * The WebSocket carries raw VNC protocol frames (no websockify encoding).
 * noVNC clients expect this format when connecting to a WebSocket endpoint.
 */
export function attachVncProxy(ws: WebSocket, req: IncomingMessage, config: VncProxyConfig): void {
  const { vncHost = "127.0.0.1", vncPort, log } = config;
  let upstream: Socket | null = null;
  let wsOpen = true;

  // Connect to VNC TCP server
  upstream = createConnection(
    {
      host: vncHost,
      port: vncPort,
    },
    () => {
      log.debug(`VNC proxy connected to ${vncHost}:${vncPort}`);
    },
  );

  // VNC server → WebSocket client
  upstream.on("data", (chunk) => {
    if (wsOpen && ws.readyState === 1) {
      try {
        ws.send(chunk, { binary: true });
      } catch (err) {
        log.warn(`VNC proxy send to WebSocket failed: ${String(err)}`);
        cleanup();
      }
    }
  });

  // VNC server closed connection
  upstream.on("close", () => {
    log.debug("VNC upstream closed");
    cleanup();
  });

  upstream.on("error", (err) => {
    log.warn(`VNC upstream error: ${String(err)}`);
    cleanup();
  });

  // WebSocket client → VNC server
  ws.on("message", (data) => {
    if (upstream && !upstream.destroyed) {
      try {
        const buffer = Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(String(data));
        upstream.write(buffer);
      } catch (err) {
        log.warn(`VNC proxy write to upstream failed: ${String(err)}`);
        cleanup();
      }
    }
  });

  ws.on("close", () => {
    log.debug("VNC WebSocket closed");
    wsOpen = false;
    cleanup();
  });

  ws.on("error", (err) => {
    log.warn(`VNC WebSocket error: ${String(err)}`);
    cleanup();
  });

  function cleanup() {
    if (upstream && !upstream.destroyed) {
      upstream.destroy();
      upstream = null;
    }
    if (wsOpen && ws.readyState < 2) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      wsOpen = false;
    }
  }
}
