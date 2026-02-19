import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { autoSolveCaptcha } from "../captcha-solver.js";
import { getCaptchaSolverConfig } from "../control-service.js";
import { getProfileContext, jsonError, toStringOrEmpty } from "./utils.js";

const log = createSubsystemLogger("browser").child("captcha");

export function registerCaptchaRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  // POST /captcha/solve - Auto-detect and solve CAPTCHA on a target
  app.post("/captcha/solve", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    const targetId = toStringOrEmpty((req.body as Record<string, unknown>)?.targetId);
    if (!targetId) {
      return jsonError(res, 400, "targetId required");
    }

    const config = getCaptchaSolverConfig();
    if (!config) {
      return jsonError(
        res,
        400,
        "CAPTCHA solver not configured. Set browser.stealth.captcha in openclaw.json",
      );
    }

    try {
      log.info(`Solving CAPTCHA for target ${targetId} using ${config.provider}...`);

      const solved = await autoSolveCaptcha(config, profileCtx.profile.cdpUrl, targetId, {
        timeoutMs: 180000, // 3 minutes
        handshakeTimeoutMs: ctx.state().resolved.remoteCdpHandshakeTimeoutMs,
      });

      if (!solved) {
        return res.json({ solved: false, message: "No CAPTCHA detected on page" });
      }

      log.info(`CAPTCHA solved successfully for target ${targetId}`);
      res.json({ solved: true });
    } catch (err) {
      log.error(`CAPTCHA solve error: ${String(err)}`);
      jsonError(res, 500, String(err));
    }
  });
}
