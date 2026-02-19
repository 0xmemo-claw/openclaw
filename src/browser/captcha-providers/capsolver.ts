import type { CaptchaDetection } from "../captcha-solver.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("captcha").child("capsolver");

const BASE_URL = "https://api.capsolver.com";
const POLL_INTERVAL_MS = 3000; // 3 seconds

export interface CapsolverOptions {
  timeoutMs?: number; // Default: 180000 (3 minutes)
}

/**
 * Solve CAPTCHA using CapSolver API.
 */
export async function solveCapsolver(
  apiKey: string,
  detection: CaptchaDetection,
  opts?: CapsolverOptions,
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 180000;

  if (!apiKey) {
    throw new Error("CapSolver API key not provided");
  }

  // Submit task
  const taskId = await submitTask(apiKey, detection);
  log.info(`Task submitted: ${taskId}`);

  // Poll for solution
  const solution = await pollSolution(apiKey, taskId, timeoutMs);
  return solution;
}

async function submitTask(apiKey: string, detection: CaptchaDetection): Promise<string> {
  const task: Record<string, unknown> = {
    websiteURL: detection.pageUrl,
  };

  if (detection.type === "arkose") {
    task.type = "FunCaptchaTaskProxyLess";
    task.websitePublicKey = detection.publicKey;
    if (detection.surl) {
      task.funcaptchaApiJSSubdomain = detection.surl;
    }
  } else if (detection.type === "turnstile") {
    task.type = "AntiTurnstileTaskProxyLess";
    task.websiteKey = detection.siteKey ?? detection.publicKey;
  } else if (detection.type === "recaptcha-v2") {
    task.type = "ReCaptchaV2TaskProxyLess";
    task.websiteKey = detection.siteKey ?? detection.publicKey;
  } else if (detection.type === "recaptcha-v3") {
    task.type = "ReCaptchaV3TaskProxyLess";
    task.websiteKey = detection.siteKey ?? detection.publicKey;
    task.pageAction = "verify"; // Default action
  } else {
    // This should never happen due to TypeScript's type narrowing
    const _exhaustive: never = detection.type;
    throw new Error(`Unsupported CAPTCHA type for CapSolver: ${String(_exhaustive)}`);
  }

  const payload = {
    clientKey: apiKey,
    task,
  };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10000); // 10s timeout for submission

  try {
    const res = await fetch(`${BASE_URL}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    const data = (await res.json()) as {
      errorId?: number;
      errorCode?: string;
      errorDescription?: string;
      taskId?: string;
    };

    if (data.errorId === 0 && data.taskId) {
      return data.taskId;
    }

    throw new Error(
      `CapSolver error: ${data.errorCode ?? "unknown"} - ${data.errorDescription ?? ""}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function pollSolution(apiKey: string, taskId: string, timeoutMs: number): Promise<string> {
  const startTime = Date.now();

  const checkSolution = async (): Promise<string | null> => {
    const payload = {
      clientKey: apiKey,
      taskId,
    };

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10000); // 10s timeout per poll

    try {
      const res = await fetch(`${BASE_URL}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      const data = (await res.json()) as {
        errorId?: number;
        errorCode?: string;
        errorDescription?: string;
        status?: string;
        solution?: {
          token?: string;
          gRecaptchaResponse?: string;
        };
      };

      if (data.errorId === 0 && data.status === "ready" && data.solution) {
        const token = data.solution.token ?? data.solution.gRecaptchaResponse;
        if (token) {
          log.info("Solution received");
          return token;
        }
      }

      if (data.status === "processing") {
        return null; // not ready yet
      }

      if (data.errorId !== 0) {
        throw new Error(
          `CapSolver error: ${data.errorCode ?? "unknown"} - ${data.errorDescription ?? ""}`,
        );
      }

      return null; // still processing
    } finally {
      clearTimeout(timeout);
    }
  };

  // Poll loop
  while (Date.now() - startTime < timeoutMs) {
    const solution = await checkSolution();
    if (solution) {
      return solution;
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    log.debug(`Waiting for solution... (${elapsed}s elapsed)`);

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error("CapSolver timeout: solution not received within timeout period");
}
