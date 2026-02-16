import type { CdpSendFn } from "./cdp.helpers.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { solveCapsolver } from "./captcha-providers/capsolver.js";
import { solve2Captcha } from "./captcha-providers/twocaptcha.js";
import { withCdpSocket, appendCdpPath } from "./cdp.helpers.js";

const log = createSubsystemLogger("browser").child("captcha");

export interface CaptchaSolverConfig {
  provider: "2captcha" | "capsolver";
  apiKey: string;
}

export interface CaptchaDetection {
  type: "arkose" | "turnstile" | "recaptcha-v2" | "recaptcha-v3";
  publicKey: string;
  pageUrl: string;
  surl?: string; // Service URL for Arkose
  siteKey?: string; // For reCAPTCHA/Turnstile (alias for publicKey)
}

export interface CaptchaSolverOptions {
  timeoutMs?: number; // Default: 180000 (3 minutes)
}

const DEFAULT_TIMEOUT_MS = 180000; // 3 minutes

/**
 * Detect CAPTCHA challenge on the page via CDP.
 * Returns detection info if found, null otherwise.
 */
export async function detectCaptchaChallenge(
  cdpUrl: string,
  targetId: string,
  opts?: { handshakeTimeoutMs?: number },
): Promise<CaptchaDetection | null> {
  const wsUrl = appendCdpPath(cdpUrl, `/devtools/page/${targetId}`);

  return withCdpSocket(
    wsUrl,
    async (send) => {
      // Get current page URL
      const navResult = (await send("Page.getNavigationHistory")) as {
        currentIndex: number;
        entries: { url: string }[];
      };
      const pageUrl = navResult?.entries?.[navResult.currentIndex]?.url ?? "https://example.com";

      // Check for Arkose FunCAPTCHA
      const arkose = await detectArkose(send, pageUrl);
      if (arkose) {
        return arkose;
      }

      // Check for Cloudflare Turnstile
      const turnstile = await detectTurnstile(send, pageUrl);
      if (turnstile) {
        return turnstile;
      }

      // Check for reCAPTCHA v2/v3
      const recaptcha = await detectRecaptcha(send, pageUrl);
      if (recaptcha) {
        return recaptcha;
      }

      return null;
    },
    { handshakeTimeoutMs: opts?.handshakeTimeoutMs },
  );
}

/**
 * Solve a detected CAPTCHA using the configured provider.
 * Returns the solution token.
 */
export async function solveCaptcha(
  config: CaptchaSolverConfig,
  detection: CaptchaDetection,
  opts?: CaptchaSolverOptions,
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  log.info(`Solving ${detection.type} CAPTCHA via ${config.provider} (timeout: ${timeoutMs}ms)...`);

  const startTime = Date.now();
  let solution: string;

  if (config.provider === "2captcha") {
    solution = await solve2Captcha(config.apiKey, detection, { timeoutMs });
  } else if (config.provider === "capsolver") {
    solution = await solveCapsolver(config.apiKey, detection, { timeoutMs });
  } else {
    // This should never happen due to TypeScript's type narrowing
    const _exhaustive: never = config.provider;
    throw new Error(`Unsupported CAPTCHA provider: ${String(_exhaustive)}`);
  }

  const elapsed = Date.now() - startTime;
  log.info(`CAPTCHA solved in ${Math.round(elapsed / 1000)}s`);

  return solution;
}

/**
 * Inject CAPTCHA solution token into the page via CDP.
 */
export async function injectCaptchaSolution(
  cdpUrl: string,
  targetId: string,
  token: string,
  detection: CaptchaDetection,
  opts?: { handshakeTimeoutMs?: number },
): Promise<void> {
  const wsUrl = appendCdpPath(cdpUrl, `/devtools/page/${targetId}`);

  await withCdpSocket(
    wsUrl,
    async (send) => {
      log.info(`Injecting ${detection.type} solution token...`);

      if (detection.type === "arkose") {
        await injectArkoseToken(send, token);
      } else if (detection.type === "turnstile") {
        await injectTurnstileToken(send, token);
      } else if (detection.type === "recaptcha-v2" || detection.type === "recaptcha-v3") {
        await injectRecaptchaToken(send, token);
      } else {
        // This should never happen due to TypeScript's type narrowing
        const _exhaustive: never = detection.type;
        throw new Error(`Unsupported CAPTCHA type: ${String(_exhaustive)}`);
      }

      log.info("CAPTCHA solution injected successfully");
    },
    { handshakeTimeoutMs: opts?.handshakeTimeoutMs },
  );
}

/**
 * High-level auto-solver: detect, solve, and inject.
 * Returns true if a CAPTCHA was solved, false if no challenge found.
 */
export async function autoSolveCaptcha(
  config: CaptchaSolverConfig,
  cdpUrl: string,
  targetId: string,
  opts?: CaptchaSolverOptions & { handshakeTimeoutMs?: number },
): Promise<boolean> {
  log.info("Auto-solving CAPTCHA...");

  const detection = await detectCaptchaChallenge(cdpUrl, targetId, {
    handshakeTimeoutMs: opts?.handshakeTimeoutMs,
  });

  if (!detection) {
    log.info("No CAPTCHA challenge detected");
    return false;
  }

  log.info(`Detected ${detection.type} CAPTCHA: ${detection.publicKey}`);

  const solution = await solveCaptcha(config, detection, opts);
  await injectCaptchaSolution(cdpUrl, targetId, solution, detection, {
    handshakeTimeoutMs: opts?.handshakeTimeoutMs,
  });

  return true;
}

// ==================== Detection Helpers ====================

async function detectArkose(send: CdpSendFn, pageUrl: string): Promise<CaptchaDetection | null> {
  try {
    const result = (await send("Runtime.evaluate", {
      expression: `
        (() => {
          // Method 1: data-public-key attribute
          const el = document.querySelector('[data-public-key]');
          if (el) {
            const pk = el.getAttribute('data-public-key');
            const surl = el.getAttribute('data-surl') || null;
            return { publicKey: pk, surl };
          }
          
          // Method 2: Arkose script tag
          const scripts = Array.from(document.querySelectorAll('script[src*="arkoselabs.com"]'));
          for (const script of scripts) {
            const match = script.src.match(/pk=([A-F0-9-]+)/i);
            if (match) {
              const surlMatch = script.src.match(/surl=([^&]+)/);
              return { 
                publicKey: match[1],
                surl: surlMatch ? decodeURIComponent(surlMatch[1]) : null
              };
            }
          }
          
          // Method 3: Arkose iframe
          const iframe = document.querySelector('iframe[src*="arkoselabs.com"]');
          if (iframe) {
            const match = iframe.src.match(/pk=([A-F0-9-]+)/i);
            if (match) {
              const surlMatch = iframe.src.match(/surl=([^&]+)/);
              return { 
                publicKey: match[1],
                surl: surlMatch ? decodeURIComponent(surlMatch[1]) : null
              };
            }
          }
          
          return null;
        })()
      `,
      returnByValue: true,
    })) as { result?: { value?: { publicKey?: string; surl?: string | null } } };

    const value = result?.result?.value;
    if (value?.publicKey) {
      return {
        type: "arkose",
        publicKey: value.publicKey,
        pageUrl,
        surl: value.surl ?? "https://client-api.arkoselabs.com",
      };
    }
  } catch (err) {
    log.debug(`Arkose detection error: ${String(err)}`);
  }
  return null;
}

async function detectTurnstile(send: CdpSendFn, pageUrl: string): Promise<CaptchaDetection | null> {
  try {
    const result = (await send("Runtime.evaluate", {
      expression: `
        (() => {
          const el = document.querySelector('[data-sitekey]');
          if (el && el.className?.includes('turnstile')) {
            return el.getAttribute('data-sitekey');
          }
          
          const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
          if (iframe) {
            const match = iframe.src.match(/sitekey=([^&]+)/);
            if (match) return decodeURIComponent(match[1]);
          }
          
          return null;
        })()
      `,
      returnByValue: true,
    })) as { result?: { value?: string } };

    const siteKey = result?.result?.value;
    if (siteKey) {
      return {
        type: "turnstile",
        publicKey: siteKey,
        siteKey,
        pageUrl,
      };
    }
  } catch (err) {
    log.debug(`Turnstile detection error: ${String(err)}`);
  }
  return null;
}

async function detectRecaptcha(send: CdpSendFn, pageUrl: string): Promise<CaptchaDetection | null> {
  try {
    const result = (await send("Runtime.evaluate", {
      expression: `
        (() => {
          // Check for explicit reCAPTCHA elements
          const v2 = document.querySelector('.g-recaptcha');
          if (v2) {
            const siteKey = v2.getAttribute('data-sitekey');
            if (siteKey) return { type: 'v2', siteKey };
          }
          
          // Check for reCAPTCHA script
          const script = document.querySelector('script[src*="recaptcha/api.js"]');
          if (script) {
            // Try to find sitekey in nearby elements
            const wrapper = document.querySelector('[data-sitekey]');
            if (wrapper) {
              return { type: 'v3', siteKey: wrapper.getAttribute('data-sitekey') };
            }
          }
          
          // Check window.grecaptcha
          if (window.grecaptcha) {
            // Attempt to extract from rendered widgets
            const widgets = document.querySelectorAll('[data-sitekey]');
            for (const w of widgets) {
              const sk = w.getAttribute('data-sitekey');
              if (sk) {
                const isV2 = w.className?.includes('g-recaptcha');
                return { type: isV2 ? 'v2' : 'v3', siteKey: sk };
              }
            }
          }
          
          return null;
        })()
      `,
      returnByValue: true,
    })) as { result?: { value?: { type: string; siteKey: string } } };

    const value = result?.result?.value;
    if (value?.siteKey) {
      const type: "recaptcha-v2" | "recaptcha-v3" =
        value.type === "v2" ? "recaptcha-v2" : "recaptcha-v3";
      return {
        type,
        publicKey: value.siteKey,
        siteKey: value.siteKey,
        pageUrl,
      };
    }
  } catch (err) {
    log.debug(`reCAPTCHA detection error: ${String(err)}`);
  }
  return null;
}

// ==================== Injection Helpers ====================

async function injectArkoseToken(send: CdpSendFn, token: string): Promise<void> {
  await send("Runtime.evaluate", {
    expression: `
      ((solutionToken) => {
        // Method 1: Token field
        const tokenField = document.querySelector('input[name="arkose_token"]') ||
                           document.querySelector('input[name="verification_string"]') ||
                           document.querySelector('[data-arkose-token]');
        if (tokenField) {
          tokenField.value = solutionToken;
          tokenField.dispatchEvent(new Event('input', { bubbles: true }));
          tokenField.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Method 2: Global callback
        if (window.arkoseCallback) {
          window.arkoseCallback({ token: solutionToken });
        }

        // Method 3: Custom event (X/Twitter pattern)
        window.dispatchEvent(new CustomEvent('arkose-token-ready', { 
          detail: { token: solutionToken } 
        }));

        // Method 4: Store in window
        window.__arkoseToken = solutionToken;
        
        console.log('[openclaw] Arkose token injected:', solutionToken.slice(0, 30) + '...');
      })('${token.replace(/'/g, "\\'")}')
    `,
  });
}

async function injectTurnstileToken(send: CdpSendFn, token: string): Promise<void> {
  await send("Runtime.evaluate", {
    expression: `
      ((solutionToken) => {
        const el = document.querySelector('[data-sitekey]');
        if (el) {
          const input = el.querySelector('input[name="cf-turnstile-response"]');
          if (input) {
            input.value = solutionToken;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        
        window.__turnstileToken = solutionToken;
        window.dispatchEvent(new CustomEvent('turnstile-token-ready', {
          detail: { token: solutionToken }
        }));
        
        console.log('[openclaw] Turnstile token injected');
      })('${token.replace(/'/g, "\\'")}')
    `,
  });
}

async function injectRecaptchaToken(send: CdpSendFn, token: string): Promise<void> {
  await send("Runtime.evaluate", {
    expression: `
      ((solutionToken) => {
        const textarea = document.querySelector('#g-recaptcha-response');
        if (textarea) {
          textarea.value = solutionToken;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        
        window.__recaptchaToken = solutionToken;
        
        if (window.grecaptcha && window.grecaptcha.enterprise) {
          // For v3 enterprise
          window.grecaptcha.enterprise.execute = () => Promise.resolve(solutionToken);
        } else if (window.grecaptcha) {
          // For v2
          window.grecaptcha.execute = () => Promise.resolve(solutionToken);
        }
        
        window.dispatchEvent(new CustomEvent('recaptcha-token-ready', {
          detail: { token: solutionToken }
        }));
        
        console.log('[openclaw] reCAPTCHA token injected');
      })('${token.replace(/'/g, "\\'")}')
    `,
  });
}
