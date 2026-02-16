import type { CaptchaDetection } from "../captcha-solver.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("captcha").child("2captcha");

const BASE_URL = "https://2captcha.com";
const POLL_INTERVAL_MS = 3000; // 3 seconds

export interface TwoCaptchaOptions {
  timeoutMs?: number; // Default: 180000 (3 minutes)
}

/**
 * Solve CAPTCHA using 2Captcha API.
 */
export async function solve2Captcha(
  apiKey: string,
  detection: CaptchaDetection,
  opts?: TwoCaptchaOptions,
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 180000;

  if (!apiKey) {
    throw new Error("2Captcha API key not provided");
  }

  // Submit task
  const taskId = await submitTask(apiKey, detection);
  log.info(`Task submitted: ${taskId}`);

  // Poll for solution
  const solution = await pollSolution(apiKey, taskId, timeoutMs);
  return solution;
}

async function submitTask(apiKey: string, detection: CaptchaDetection): Promise<string> {
  const params = new URLSearchParams({
    key: apiKey,
    json: "1",
  });

  if (detection.type === "arkose") {
    params.append("method", "funcaptcha");
    params.append("publickey", detection.publicKey);
    params.append("pageurl", detection.pageUrl);
    if (detection.surl) {
      params.append("surl", detection.surl);
    }
  } else if (detection.type === "turnstile") {
    params.append("method", "turnstile");
    params.append("sitekey", detection.siteKey ?? detection.publicKey);
    params.append("pageurl", detection.pageUrl);
  } else if (detection.type === "recaptcha-v2") {
    params.append("method", "userrecaptcha");
    params.append("googlekey", detection.siteKey ?? detection.publicKey);
    params.append("pageurl", detection.pageUrl);
  } else if (detection.type === "recaptcha-v3") {
    params.append("method", "userrecaptcha");
    params.append("version", "v3");
    params.append("googlekey", detection.siteKey ?? detection.publicKey);
    params.append("pageurl", detection.pageUrl);
    params.append("action", "verify"); // Default action
  } else {
    // This should never happen due to TypeScript's type narrowing
    const _exhaustive: never = detection.type;
    throw new Error(`Unsupported CAPTCHA type for 2Captcha: ${String(_exhaustive)}`);
  }

  const url = `${BASE_URL}/in.php?${params.toString()}`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10000); // 10s timeout for submission

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();

    let data: { status: number; request?: string; error_text?: string };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid 2Captcha response: ${text}`);
    }

    if (data.status === 1 && data.request) {
      return data.request; // task ID
    }

    throw new Error(`2Captcha error: ${data.request ?? data.error_text ?? "unknown"}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function pollSolution(apiKey: string, taskId: string, timeoutMs: number): Promise<string> {
  const startTime = Date.now();

  const checkSolution = async (): Promise<string | null> => {
    const url = `${BASE_URL}/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10000); // 10s timeout per poll

    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const text = await res.text();

      let data: { status: number; request?: string; error_text?: string };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Invalid 2Captcha response: ${text}`);
      }

      if (data.status === 1 && data.request) {
        return data.request; // solution token
      }

      if (data.request === "CAPCHA_NOT_READY") {
        return null; // not ready yet
      }

      throw new Error(`2Captcha error: ${data.request ?? data.error_text ?? "unknown"}`);
    } finally {
      clearTimeout(timeout);
    }
  };

  // Poll loop
  while (Date.now() - startTime < timeoutMs) {
    const solution = await checkSolution();
    if (solution) {
      log.info("Solution received");
      return solution;
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    log.debug(`Waiting for solution... (${elapsed}s elapsed)`);

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error("2Captcha timeout: solution not received within timeout period");
}
