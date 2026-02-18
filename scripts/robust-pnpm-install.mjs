#!/usr/bin/env node

/**
 * Robust pnpm install with retry logic and proxy bypass
 * Supports MetaMask harness dependencies
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

class RobustPNPMInstall {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || MAX_RETRIES;
    this.retryDelay = options.retryDelay || RETRY_DELAY;
    this.useProxy = options.useProxy !== false;
    this.registry = options.registry || undefined;
    this.offline = options.offline || false;
    this.fallbackRegistry = options.fallbackRegistry || "https://registry.npmjs.org";
    this.logFile = options.logFile || "./pnpm-install.log";
  }

  async run() {
    console.log("Starting robust pnpm install...");

    // Create log file
    const logStream = createWriteStream(this.logFile, { flags: "a" });

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      console.log(`\nAttempt ${attempt}/${this.maxRetries}`);

      try {
        await this.executePNPM(logStream);
        console.log("✅ pnpm install completed successfully");
        return true;
      } catch (error) {
        console.error(`❌ Attempt ${attempt} failed:`, error.message);

        if (attempt === this.maxRetries) {
          console.error("🚨 All retries exhausted. Check the logs for details.");
          return false;
        }

        console.log(`⏳ Waiting ${this.retryDelay / 1000}s before retry...`);
        await this.delay(this.retryDelay);

        // Try fallback registry on second attempt
        if (attempt === 2 && !this.registry) {
          console.log("🔄 Trying fallback registry...");
          this.registry = this.fallbackRegistry;
        }
      }
    }

    return false;
  }

  async executePNPM(logStream) {
    return new Promise((resolve, reject) => {
      const args = ["install"];

      if (this.offline) {
        args.push("--offline");
      }

      if (this.registry) {
        args.push("--registry", this.registry);
        console.log(`📦 Using registry: ${this.registry}`);
      }

      if (this.useProxy) {
        args.push("--filter=.", "--frozen-lockfile=false");
      }

      console.log(`🚀 Running: pnpm ${args.join(" ")}`);

      const pnpm = spawn("pnpm", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PNPM_PROGRESS_LOGLEVEL: "error",
          NODE_ENV: "production",
        },
      });

      let output = "";

      pnpm.stdout.on("data", (data) => {
        const text = data.toString();
        output += text;
        logStream.write(`STDOUT: ${text}`);
        console.log(text.trim());
      });

      pnpm.stderr.on("data", (data) => {
        const text = data.toString();
        output += text;
        logStream.write(`STDERR: ${text}`);
        console.error(text.trim());
      });

      pnpm.on("close", (code) => {
        logStream.end();

        if (code === 0) {
          resolve(true);
        } else {
          const error = new Error(`pnpm install failed with code ${code}`);
          error.code = code;
          error.output = output;
          reject(error);
        }
      });

      pnpm.on("error", (error) => {
        logStream.end();
        reject(error);
      });

      // Handle timeout
      setTimeout(() => {
        pnpm.kill("SIGTERM");
        reject(new Error("pnpm install timeout"));
      }, 300000); // 5 minutes
    });
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const options = {
    maxRetries:
      parseInt(args.find((arg) => arg.startsWith("--max-retries="))?.split("=")[1]) || MAX_RETRIES,
    retryDelay:
      parseInt(args.find((arg) => arg.startsWith("--retry-delay="))?.split("=")[1]) || RETRY_DELAY,
    useProxy: !args.includes("--no-proxy"),
    registry: args.find((arg) => arg.startsWith("--registry="))?.split("=")[1],
    offline: args.includes("--offline"),
    fallbackRegistry:
      args.find((arg) => arg.startsWith("--fallback-registry="))?.split("=")[1] ||
      "https://registry.npmjs.org",
    logFile:
      args.find((arg) => arg.startsWith("--log-file="))?.split("=")[1] || "./pnpm-install.log",
  };

  const installer = new RobustPNPMInstall(options);
  installer
    .run()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error("Installation failed:", error);
      process.exit(1);
    });
}

export default RobustPNPMInstall;
