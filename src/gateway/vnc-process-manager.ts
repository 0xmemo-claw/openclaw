import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { createSubsystemLogger } from "../logging/subsystem.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type VncProcessManagerConfig = {
  displayNumber?: number;
  vncPort?: number;
  xvfbResolution?: string;
  xvfbDepth?: number;
  log: SubsystemLogger;
};

export class VncProcessManager {
  private xvfb: ChildProcess | null = null;
  private x11vnc: ChildProcess | null = null;
  private displayNumber: number;
  private vncPort: number;
  private xvfbResolution: string;
  private xvfbDepth: number;
  private log: SubsystemLogger;
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private stopping = false;

  constructor(config: VncProcessManagerConfig) {
    this.displayNumber = config.displayNumber ?? 99;
    this.vncPort = config.vncPort ?? 5900;
    this.xvfbResolution = config.xvfbResolution ?? "1920x1080";
    this.xvfbDepth = config.xvfbDepth ?? 24;
    this.log = config.log;
  }

  /**
   * Start Xvfb (virtual display) and x11vnc (VNC server).
   * Returns true if both processes started successfully.
   */
  async start(): Promise<boolean> {
    this.stopping = false;

    // Check if binaries exist
    if (!this.checkBinaries()) {
      this.log.warn(
        "VNC disabled: Xvfb or x11vnc not found. Install with: apt-get install xvfb x11vnc",
      );
      return false;
    }

    // Start Xvfb
    if (!this.startXvfb()) {
      return false;
    }

    // Wait for X server to be ready
    await this.waitForDisplay();

    // Start x11vnc
    if (!this.startX11vnc()) {
      this.stopXvfb();
      return false;
    }

    this.log.info(`VNC server started on :${this.displayNumber} (port ${this.vncPort})`);
    return true;
  }

  /**
   * Stop all VNC processes.
   */
  stop(): void {
    this.stopping = true;
    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
    this.stopX11vnc();
    this.stopXvfb();
    this.log.info("VNC processes stopped");
  }

  private checkBinaries(): boolean {
    try {
      execSync("which Xvfb", { stdio: "pipe" });
      execSync("which x11vnc", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  private startXvfb(): boolean {
    if (this.xvfb) {
      return true;
    }

    const display = `:${this.displayNumber}`;
    const lockFile = `/tmp/.X${this.displayNumber}-lock`;

    // If Xvfb is already running externally on this display, reuse it
    if (existsSync(lockFile)) {
      try {
        const pid = execSync(`cat ${lockFile}`, { stdio: "pipe" }).toString().trim();
        if (pid && existsSync(`/proc/${pid}`)) {
          this.log.info(`Reusing existing Xvfb on ${display} (PID ${pid})`);
          return true;
        }
      } catch {
        // stale lock, clean up below
      }
      try {
        execSync(`rm -f ${lockFile}`, { stdio: "pipe" });
      } catch {
        // ignore
      }
    }

    this.log.debug(`Starting Xvfb on ${display} (${this.xvfbResolution}x${this.xvfbDepth})`);

    this.xvfb = spawn(
      "Xvfb",
      [
        display,
        "-screen",
        "0",
        `${this.xvfbResolution}x${this.xvfbDepth}`,
        "-ac",
        "-nolisten",
        "tcp",
        "-dpi",
        "96",
        "+extension",
        "GLX",
      ],
      {
        stdio: "pipe",
        detached: false,
      },
    );

    this.xvfb.on("error", (err) => {
      this.log.warn(`Xvfb error: ${String(err)}`);
      this.scheduleRestart("xvfb");
    });

    this.xvfb.on("exit", (code, signal) => {
      this.log.warn(`Xvfb exited (code=${code}, signal=${signal})`);
      this.xvfb = null;
      if (!this.stopping) {
        this.scheduleRestart("xvfb");
      }
    });

    return true;
  }

  private stopXvfb(): void {
    if (this.xvfb) {
      try {
        this.xvfb.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.xvfb = null;
    }
  }

  private startX11vnc(): boolean {
    if (this.x11vnc) {
      return true;
    }

    const display = `:${this.displayNumber}`;

    this.log.debug(`Starting x11vnc on port ${this.vncPort} for display ${display}`);

    this.x11vnc = spawn(
      "x11vnc",
      [
        "-display",
        display,
        "-rfbport",
        String(this.vncPort),
        "-forever",
        "-shared",
        "-nopw",
        "-noxdamage",
        "-noxfixes",
        "-noxrecord",
        "-noxkb",
        "-repeat",
        "-cursor",
        "arrow",
      ],
      {
        stdio: "pipe",
        detached: false,
        env: { ...process.env, DISPLAY: display },
      },
    );

    this.x11vnc.on("error", (err) => {
      this.log.warn(`x11vnc error: ${String(err)}`);
      this.scheduleRestart("x11vnc");
    });

    this.x11vnc.on("exit", (code, signal) => {
      this.log.warn(`x11vnc exited (code=${code}, signal=${signal})`);
      this.x11vnc = null;
      if (!this.stopping) {
        this.scheduleRestart("x11vnc");
      }
    });

    // Capture stderr for debugging
    this.x11vnc.stderr?.on("data", (chunk) => {
      const msg = String(chunk).trim();
      if (msg && !msg.includes("Got connection from client")) {
        this.log.debug(`x11vnc: ${msg}`);
      }
    });

    return true;
  }

  private stopX11vnc(): void {
    if (this.x11vnc) {
      try {
        this.x11vnc.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.x11vnc = null;
    }
  }

  private scheduleRestart(process: "xvfb" | "x11vnc"): void {
    if (this.stopping) {
      return;
    }

    const existing = this.restartTimers.get(process);
    if (existing) {
      return; // Already scheduled
    }

    this.log.info(`Scheduling ${process} restart in 5s...`);
    const timer = setTimeout(() => {
      this.restartTimers.delete(process);
      if (this.stopping) {
        return;
      }
      this.log.info(`Restarting ${process}...`);
      if (process === "xvfb") {
        this.startXvfb();
        // Restart x11vnc after Xvfb is back
        setTimeout(() => {
          if (!this.stopping) {
            this.stopX11vnc();
            this.startX11vnc();
          }
        }, 2000);
      } else {
        this.startX11vnc();
      }
    }, 5000);

    this.restartTimers.set(process, timer);
  }

  private async waitForDisplay(): Promise<void> {
    const lockFile = `/tmp/.X${this.displayNumber}-lock`;
    const maxWaitMs = 5000;
    const startMs = Date.now();

    while (Date.now() - startMs < maxWaitMs) {
      if (existsSync(lockFile)) {
        // Give it another moment to fully initialize
        await new Promise((resolve) => setTimeout(resolve, 200));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.log.warn(`Xvfb display :${this.displayNumber} did not start within ${maxWaitMs}ms`);
  }

  getDisplayEnv(): string {
    return `:${this.displayNumber}`;
  }

  getVncPort(): number {
    return this.vncPort;
  }

  isRunning(): boolean {
    return this.xvfb !== null && this.x11vnc !== null;
  }
}
