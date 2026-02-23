#!/usr/bin/env node

/**
 * Integration test for browser extension support
 * Tests MetaMask extension loading and functionality
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

class BrowserExtensionTest {
  constructor() {
    this.testResults = [];
    this.browserConfig = {
      browserType: "chromium",
      headless: false,
      extensionPath: "./extensions/metamask",
      userDataDir: "./test-data/browser-extensions",
      cdpPort: 9223,
    };
  }

  async run() {
    console.log("🧪 Starting browser extension integration tests...\n");

    const tests = [
      () => this.testExtensionExists(),
      () => this.testBrowserConfig(),
      () => this.testPNPMInstall(),
      () => this.testExtensionLoading(),
      () => this.testMetaMaskFunctionality(),
    ];

    for (const test of tests) {
      try {
        test();
      } catch (error) {
        this.addResult("❌", test.name, error.message);
      }
    }

    this.generateReport();
    return this.allPassed();
  }

  testExtensionExists() {
    console.log("📦 Testing MetaMask extension existence...");

    const manifestPath = join(this.browserConfig.extensionPath, "manifest.json");

    if (!existsSync(manifestPath)) {
      throw new Error(`Extension manifest not found at ${manifestPath}`);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    if (manifest.manifest_version !== 3) {
      throw new Error("Extension must use manifest version 3");
    }

    if (manifest.name !== "MetaMask Dummy Extension") {
      throw new Error("Extension name does not match expected value");
    }

    this.addResult("✅", "testExtensionExists", "Extension manifest is valid");
  }

  testBrowserConfig() {
    console.log("⚙️  Testing browser configuration...");

    const configPath = "./browser-extension-config.json";

    if (!existsSync(configPath)) {
      throw new Error("Browser extension config not found");
    }

    const config = JSON.parse(readFileSync(configPath, "utf8"));

    if (!config.profiles["chrome-with-extensions"]) {
      throw new Error("chrome-with-extensions profile not found in config");
    }

    if (!config.profiles["metamask-harness"]) {
      throw new Error("metamask-harness profile not found in config");
    }

    this.addResult("✅", "testBrowserConfig", "Browser configuration is valid");
  }

  testPNPMInstall() {
    console.log("📥 Testing pnpm install with retry logic...");

    return new Promise((resolve, reject) => {
      const installer = spawn("node", [
        "./scripts/robust-pnpm-install.mjs",
        "--max-retries=2",
        "--retry-delay=1000",
        "--log-file=./test-data/pnpm-install-test.log",
      ]);

      installer.on("close", (code) => {
        if (code === 0) {
          this.addResult("✅", "testPNPMInstall", "PNPM install completed successfully");
          resolve();
        } else {
          reject(new Error(`PNPM install failed with code ${code}`));
        }
      });

      installer.on("error", (error) => {
        reject(error);
      });

      // Timeout after 2 minutes
      setTimeout(() => {
        installer.kill("SIGTERM");
        reject(new Error("PNPM install timeout"));
      }, 120000);
    });
  }

  testExtensionLoading() {
    console.log("🌐 Testing extension loading...");

    // This would typically involve launching a browser and checking extensions
    // For now, we'll test the configuration and file structure

    const extensionPath = this.browserConfig.extensionPath;

    if (!existsSync(join(extensionPath, "manifest.json"))) {
      throw new Error("Extension manifest not found");
    }

    if (!existsSync(join(extensionPath, "background.js"))) {
      throw new Error("Background script not found");
    }

    if (!existsSync(join(extensionPath, "content.js"))) {
      throw new Error("Content script not found");
    }

    this.addResult("✅", "testExtensionLoading", "Extension files are properly structured");
  }

  testMetaMaskFunctionality() {
    console.log("🔐 Testing MetaMask functionality simulation...");

    // Test MetaMask configuration
    const configPath = "./browser-extension-config.json";
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const metamaskConfig = config.profiles["metamask-harness"];

    if (!metamaskConfig.metamaskConfig) {
      throw new Error("MetaMask configuration not found");
    }

    const { seedPhrase, network, chainId, rpcUrl } = metamaskConfig.metamaskConfig;

    if (!seedPhrase || !network || !chainId || !rpcUrl) {
      throw new Error("MetaMask configuration is incomplete");
    }

    if (chainId !== 31337) {
      throw new Error(`Expected chainId 31337, got ${chainId}`);
    }

    if (!rpcUrl.includes("awsapprunner.com")) {
      throw new Error(`Expected RPC URL to contain awsapprunner.com, got ${rpcUrl}`);
    }

    this.addResult("✅", "testMetaMaskFunctionality", "MetaMask configuration is valid");
  }

  addResult(status, test, message) {
    this.testResults.push({ status, test, message });
    console.log(`${status} ${test}: ${message}`);
  }

  allPassed() {
    return this.testResults.every((result) => result.status === "✅");
  }

  generateReport() {
    console.log("\n📊 Test Report");
    console.log("=".repeat(50));

    const passed = this.testResults.filter((r) => r.status === "✅").length;
    const failed = this.testResults.filter((r) => r.status === "❌").length;

    console.log(`\n📈 Summary: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.log("\n❌ Failed Tests:");
      this.testResults
        .filter((r) => r.status === "❌")
        .forEach((result) => {
          console.log(`  - ${result.test}: ${result.message}`);
        });
    }

    console.log("\n🎯 Next Steps:");
    console.log("1. Review failed tests above");
    console.log("2. Check test-data/ directory for logs");
    console.log("3. Run individual tests if needed");
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const test = new BrowserExtensionTest();

  // Create test data directory
  mkdirSync("./test-data", { recursive: true });

  test
    .run()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error("Test suite failed:", error);
      process.exit(1);
    });
}

export default BrowserExtensionTest;
