# Browser Extension Support for E2E Testing

This document describes how to configure and use browser extensions (specifically MetaMask) with OpenClaw for end-to-end testing.

## Overview

OpenClaw now supports loading browser extensions during browser automation, enabling E2E testing for decentralized applications (dApps) that require wallet integration like MetaMask.

## Configuration

### 1. Browser Extension Configuration

Create or modify `browser-extension-config.json` to define extension profiles:

```json
{
  "profiles": {
    "metamask-harness": {
      "browserType": "chromium",
      "headless": false,
      "channel": "chrome",
      "launchOptions": {
        "args": [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-web-security"
        ]
      },
      "extensionSupport": {
        "enabled": true,
        "extensionPath": "./extensions/metamask",
        "allowedExtensions": ["*.crx", "*.zip"],
        "disableExtensionsExcept": ["nkbihfbeogeaofhmdljebnjkhfhkfgj"],
        "loadExtension": "./extensions/metamask"
      },
      "userDataDir": "./browser-data/metamask-harness",
      "cdpPort": 9222,
      "metamaskConfig": {
        "seedPhrase": "test test test test test test test test test test test junk",
        "network": "localhost",
        "chainId": 31337,
        "rpcUrl": "https://vfgvanuabr.eu-central-1.awsapprunner.com/"
      }
    }
  }
}
```

### 2. Extension Directory Structure

Your extension should be organized as follows:

```
extensions/
├── metamask/
│   ├── manifest.json         # Extension manifest (v3)
│   ├── background.js         # Background service worker
│   ├── content.js           # Content script
│   ├── popup.html           # Popup UI
│   └── popup.js             # Popup script
```

## Usage

### 1. Install Dependencies with Retry Logic

Use the robust pnpm installer to handle connection issues:

```bash
node ./scripts/robust-pnpm-install.mjs \
  --max-retries=3 \
  --retry-delay=2000 \
  --registry=https://registry.npmjs.org \
  --fallback-registry=https://registry.yarnpkg.com
```

### 2. Run Extension Tests

Execute the integration test suite:

```bash
node ./scripts/test-browser-extension.mjs
```

### 3. Launch Browser with Extension

Using the browser tool:

```javascript
import { browser } from "./src/browser/index.js";

// Launch with MetaMask extension
await browser.action("start", {
  profile: "metamask-harness",
  targetUrl: "https://your-dapp.com",
});

// Perform dApp interactions
await browser.action("act", {
  kind: "click",
  ref: "connect-wallet-button",
});
```

## Advanced Configuration

### Proxy and Network Settings

If you need to bypass proxies for certain registries:

```json
{
  "registryOverrides": {
    "https://registry.npmjs.org": true,
    "https://registry.yarnpkg.com": true,
    "https://registry.npmjs.org/-/binary": true
  }
}
```

### Custom Extension Paths

For different extension versions or custom builds:

```json
{
  "extensionPaths": {
    "metamask": "./extensions/metamask-v10.0.0",
    "custom-wallet": "./extensions/custom-wallet"
  }
}
```

## Environment Variables

Set these environment variables for different environments:

```bash
# Development
OPENCLAW_BROWSER_HEADLESS=false
OPENCLAW_BROWSER_DEVTOOLS=true
OPENCLAW_BROWSER_SLOWMO=100

# Production
OPENCLAW_BROWSER_HEADLESS=true
OPENCLAW_BROWSER_DEVTOOLS=false
```

## Troubleshooting

### Common Issues

1. **Extension Not Loading**
   - Check manifest.json syntax
   - Verify file permissions
   - Ensure all required files exist

2. **Connection Timeouts**
   - Use the robust pnpm installer
   - Check network connectivity
   - Try alternative registries

3. **CDP Connection Issues**
   - Verify CDP port is available
   - Check firewall settings
   - Ensure browser is not already running on the port

### Debug Mode

Enable debug logging:

```bash
OPENCLAW_BROWSER_DEBUG=1 node ./scripts/test-browser-extension.mjs
```

### Logs and Artifacts

- Test logs: `./test-data/`
- Browser logs: `./browser-data/`
- Installation logs: `./pnpm-install.log`

## MetaMask Specific Configuration

For MetaMask testing, ensure your configuration includes:

```json
{
  "metamaskConfig": {
    "seedPhrase": "test test test test test test test test test test test junk",
    "network": "localhost",
    "chainId": 31337,
    "rpcUrl": "https://your-rpc-endpoint.com"
  }
}
```

## Security Considerations

1. **Never commit real seed phrases** to version control
2. **Use environment variables** for sensitive configuration
3. **Restrict extension permissions** to only what's necessary
4. **Regularly update extension versions** for security patches

## Integration Example

Here's a complete example of testing a dApp with MetaMask:

```javascript
import { browser } from "./src/browser/index.js";

async function testDAppWithMetaMask() {
  // Launch browser with MetaMask
  await browser.action("start", {
    profile: "metamask-harness",
    targetUrl: "https://your-dapp.com",
  });

  // Connect wallet
  await browser.action("act", {
    kind: "click",
    ref: "connect-wallet-button",
  });

  // Wait for connection
  await browser.action("act", {
    kind: "wait",
    textGone: "Connecting...",
  });

  // Perform transaction
  await browser.action("act", {
    kind: "click",
    ref: "create-market-button",
  });

  // Confirm in MetaMask popup
  await browser.action("act", {
    kind: "click",
    ref: "confirm-transaction",
  });

  // Verify success
  await browser.action("act", {
    kind: "wait",
    textGone: "Creating...",
  });
}
```

## Best Practices

1. **Use persistent user data directories** for consistent testing state
2. **Isolate test environments** with separate browser profiles
3. **Clean up browser state** between tests
4. **Use realistic test data** (seed phrases, accounts)
5. **Monitor network requests** for debugging
6. **Capture screenshots** for visual verification

## References

- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/)
- [Playwright Browser Extension Support](https://playwright.dev/docs/api/class-browser#browsernewcontext-options)
- [MetaMask Developer Documentation](https://docs.metamask.io/guide/)
- [OpenClaw Browser Tool Documentation](https://docs.openclaw.ai/tools/browser)
