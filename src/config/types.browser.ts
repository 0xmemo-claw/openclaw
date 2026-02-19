export type BrowserProfileConfig = {
  /** CDP port for this profile. Allocated once at creation, persisted permanently. */
  cdpPort?: number;
  /** CDP URL for this profile (use for remote Chrome). */
  cdpUrl?: string;
  /** Profile driver (default: openclaw). */
  driver?: "openclaw" | "extension";
  /** Profile color (hex). Auto-assigned at creation. */
  color: string;
};
export type BrowserSnapshotDefaults = {
  /** Default snapshot mode (applies when mode is not provided). */
  mode?: "efficient";
};
export type BrowserStealthConfig = {
  /** Enable stealth scripts injection. Default: true */
  enabled?: boolean;
  /** Proxy configuration for stealth browsing. */
  proxy?: {
    /** Proxy URL (supports ${ENV_VAR} syntax), e.g. "${BROWSER_PROXY_URL}" or "http://user:pass@proxy.com:8080" */
    url?: string;
    /** Domains to bypass the proxy for. */
    bypassList?: string[];
  };
  /** Custom user-agent override. */
  userAgent?: string;
  /** Geolocation spoofing for the stealth script. */
  geolocation?: {
    latitude?: number;
    longitude?: number;
    city?: string;
  };
  /** CAPTCHA service configuration for automated solving. */
  captcha?: {
    /** CAPTCHA service provider. */
    provider?: "2captcha" | "capsolver";
    /** API key for the CAPTCHA service (supports ${ENV_VAR} syntax), e.g. "${TWOCAPTCHA_API_KEY}". */
    apiKey?: string;
  };
};

export type BrowserExtensionConfig = {
  /** Enable extension loading for unpacked Chrome extensions. */
  enabled?: boolean;
  /**
   * Paths to unpacked extension directories.
   *
   * Supported formats:
   * - "~/.openclaw/extensions/metamask" (home expansion)
   * - "$HOME/.openclaw/extensions/rabby" (env expansion)
   *
   * How to get unpacked extensions:
   * - Download from Chrome Web Store and extract the .crx package
   * - Reuse an unpacked folder exported by another browser via --extensions-path
   * - Download unpacked releases from vendor GitHub releases (MetaMask, Rabby, Phantom, etc.)
   */
  paths?: string[];
};

export type BrowserConfig = {
  enabled?: boolean;
  /** If false, disable browser act:evaluate (arbitrary JS). Default: true */
  evaluateEnabled?: boolean;
  /** Base URL of the CDP endpoint (for remote browsers). Default: loopback CDP on the derived port. */
  cdpUrl?: string;
  /** Remote CDP HTTP timeout (ms). Default: 1500. */
  remoteCdpTimeoutMs?: number;
  /** Remote CDP WebSocket handshake timeout (ms). Default: max(remoteCdpTimeoutMs * 2, 2000). */
  remoteCdpHandshakeTimeoutMs?: number;
  /** Accent color for the openclaw browser profile (hex). Default: #FF4500 */
  color?: string;
  /** Override the browser executable path (all platforms). */
  executablePath?: string;
  /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean;
  /** Pass --no-sandbox to Chrome (Linux containers). Default: false */
  noSandbox?: boolean;
  /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean;
  /** Default profile to use when profile param is omitted. Default: "chrome" */
  defaultProfile?: string;
  /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>;
  /** Stealth / anti-detection configuration. */
  stealth?: BrowserStealthConfig;
  /** Default snapshot options (applied by the browser tool/CLI when unset). */
  snapshotDefaults?: BrowserSnapshotDefaults;
  /** Generic unpacked Chrome extension loading config. */
  extensions?: BrowserExtensionConfig;
  /**
   * Additional Chrome launch arguments.
   * Useful for stealth flags, window size overrides, or custom user-agent strings.
   * Example: ["--window-size=1920,1080", "--disable-infobars"]
   */
  extraArgs?: string[];
};
