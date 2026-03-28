/**
 * Remote Desktop MCP App - noVNC viewer for connecting to webtops over HTTPS.
 *
 * Connects to any VNC desktop via websockify using the noVNC library.
 * Falls back to "Open in Browser" when the embedded connection fails.
 */
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import styles from "./mcp-app.module.css";

const IMPLEMENTATION = { name: "Remote Desktop Viewer", version: "0.2.0" };

// noVNC RFB type (loaded dynamically from CDN)
interface RFBInstance {
  scaleViewport: boolean;
  resizeSession: boolean;
  disconnect(): void;
  addEventListener(type: string, listener: (event: CustomEvent) => void): void;
  sendCredentials(credentials: { password: string }): void;
}

interface DesktopInfo {
  name: string;
  url: string;
  wsUrl: string;
  password?: string;
}

type ConnectionState =
  | "loading"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "csp-blocked";

const log = {
  info: console.log.bind(console, "[VNC]"),
  warn: console.warn.bind(console, "[VNC]"),
  error: console.error.bind(console, "[VNC]"),
};

// noVNC loading state
let RFBClass: new (
  target: HTMLElement,
  url: string,
  options?: { credentials?: { password?: string } },
) => RFBInstance;
let rfbLoadPromise: Promise<void> | null = null;
let rfbLoadFailed = false;

async function loadNoVNC(): Promise<void> {
  if (RFBClass) return;
  if (rfbLoadFailed) throw new Error("VNC library blocked by CSP");
  if (rfbLoadPromise) return rfbLoadPromise;

  const NOVNC_CDN_URL =
    "https://cdn.jsdelivr.net/npm/@novnc/novnc@1.6.0/+esm";

  rfbLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.textContent = `
      import * as noVNC from "${NOVNC_CDN_URL}";
      let RFB = noVNC.default;
      if (RFB && typeof RFB !== 'function' && RFB.default) {
        RFB = RFB.default;
      }
      window.__noVNC_RFB = RFB;
      window.dispatchEvent(new Event("novnc-loaded"));
    `;

    const timeoutId = setTimeout(() => {
      rfbLoadFailed = true;
      window.removeEventListener("novnc-loaded", handleLoad);
      reject(new Error("VNC library load timeout - likely blocked by CSP"));
    }, 10000);

    const handleLoad = () => {
      clearTimeout(timeoutId);
      RFBClass = (window as unknown as { __noVNC_RFB: typeof RFBClass })
        .__noVNC_RFB;
      window.removeEventListener("novnc-loaded", handleLoad);
      if (RFBClass && typeof RFBClass === "function") {
        log.info("noVNC loaded successfully");
        resolve();
      } else {
        rfbLoadFailed = true;
        reject(new Error("VNC library failed to initialize"));
      }
    };

    window.addEventListener("novnc-loaded", handleLoad);

    try {
      document.head.appendChild(script);
    } catch {
      clearTimeout(timeoutId);
      rfbLoadFailed = true;
      window.removeEventListener("novnc-loaded", handleLoad);
      reject(new Error("VNC library blocked by CSP"));
    }
  });

  return rfbLoadPromise;
}

/**
 * Parse query params for standalone testing mode.
 * URL format: ?wsUrl=wss://host:port/websockify&name=test&password=secret
 */
function getStandaloneDesktopInfo(): DesktopInfo | null {
  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get("wsUrl");
  if (!wsUrl) return null;

  const url = wsUrl
    .replace(/^wss/, "https")
    .replace(/^ws/, "http")
    .replace(/\/websockify$/, "");
  return {
    name: params.get("name") || "Standalone Desktop",
    url,
    wsUrl,
    password: params.get("password") || "",
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function StandaloneMode({ desktopInfo }: { desktopInfo: DesktopInfo }) {
  return (
    <ViewDesktopInner
      app={null}
      toolResult={null}
      hostContext={undefined}
      desktopInfo={desktopInfo}
    />
  );
}

function HostedMode() {
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);

  const { app, error } = useApp({
    appInfo: IMPLEMENTATION,
    capabilities: {},
    onAppCreated: (app) => {
      app.onteardown = async () => ({});
      app.ontoolinput = async (input) => log.info("Tool input:", input);

      app.ontoolresult = async (result) => {
        log.info("Tool result:", result);
        setToolResult(result);
        const structured = result.structuredContent as DesktopInfo | undefined;
        if (structured?.wsUrl) setDesktopInfo(structured);
      };

      app.onerror = log.error;
      app.onhostcontextchanged = (params) =>
        setHostContext((prev) => ({ ...prev, ...params }));
    },
  });

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  if (error) {
    return (
      <div className={styles.error}>
        <strong>Error:</strong> {error.message}
      </div>
    );
  }

  if (!app) {
    return <div className={styles.loading}>Connecting to host...</div>;
  }

  return (
    <ViewDesktopInner
      app={app}
      toolResult={toolResult}
      hostContext={hostContext}
      desktopInfo={desktopInfo}
    />
  );
}

function ViewDesktopApp() {
  const standaloneInfo = useMemo(() => getStandaloneDesktopInfo(), []);
  if (standaloneInfo) return <StandaloneMode desktopInfo={standaloneInfo} />;
  return <HostedMode />;
}

// ---------------------------------------------------------------------------
// Main viewer
// ---------------------------------------------------------------------------

interface ViewDesktopInnerProps {
  app: App | null;
  toolResult: CallToolResult | null;
  hostContext?: McpUiHostContext;
  desktopInfo: DesktopInfo | null;
}

function ViewDesktopInner({
  app,
  toolResult,
  hostContext,
  desktopInfo,
}: ViewDesktopInnerProps) {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBInstance | null>(null);
  const isConnectingRef = useRef(false);

  const extractedInfo = useExtractDesktopInfo(toolResult, desktopInfo);

  const [noVncReady, setNoVncReady] = useState(false);

  // Load noVNC library
  useEffect(() => {
    loadNoVNC()
      .then(() => {
        setNoVncReady(true);
        setConnectionState("connecting");
      })
      .catch((e) => {
        log.warn("noVNC load failed:", e.message);
        setConnectionState("csp-blocked");
        setErrorMessage(
          "Embedded viewer not available. Please open in browser.",
        );
      });
  }, []);

  // Connect to VNC server
  const connect = useCallback(() => {
    if (!extractedInfo || !containerRef.current || !RFBClass) return;
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;

    if (rfbRef.current) {
      rfbRef.current.disconnect();
      rfbRef.current = null;
    }
    containerRef.current.innerHTML = "";

    setConnectionState("connecting");
    setErrorMessage(null);

    try {
      log.info("Connecting to", extractedInfo.wsUrl);
      const password = extractedInfo.password ?? "";

      const rfb = new RFBClass(containerRef.current, extractedInfo.wsUrl, {
        credentials: { password },
      });

      rfb.scaleViewport = true;
      rfb.resizeSession = false;

      rfb.addEventListener("connect", () => {
        log.info("Connected to VNC server");
        isConnectingRef.current = false;
        setConnectionState("connected");
        setErrorMessage(null);
      });

      rfb.addEventListener(
        "disconnect",
        (e: CustomEvent<{ clean: boolean; reason?: string }>) => {
          log.info("Disconnected:", e.detail.clean, e.detail.reason);
          isConnectingRef.current = false;
          setConnectionState("disconnected");
          setErrorMessage(
            e.detail.clean
              ? `Desktop disconnected. ${e.detail.reason || ""}`
              : "Connection lost. Click Reconnect to try again.",
          );
        },
      );

      rfb.addEventListener("securityfailure", (e: CustomEvent) => {
        log.error("Security failure:", e.detail);
        isConnectingRef.current = false;
        setConnectionState("error");
        setErrorMessage(
          `Security failure: ${(e.detail as { reason?: string })?.reason || "Unknown"}`,
        );
      });

      rfb.addEventListener("credentialsrequired", () => {
        log.info("Credentials required, sending password");
        rfb.sendCredentials({ password });
      });

      rfbRef.current = rfb;
    } catch (e) {
      log.error("Failed to connect:", e);
      isConnectingRef.current = false;
      setConnectionState("error");
      setErrorMessage(
        `Failed to connect: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [extractedInfo]);

  // Trigger connection when ready
  useEffect(() => {
    if (
      noVncReady &&
      extractedInfo &&
      containerRef.current &&
      RFBClass &&
      connectionState === "connecting"
    ) {
      connect();
    }
  }, [noVncReady, extractedInfo, connectionState, connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
    };
  }, []);

  // Periodic screenshot updates to model context
  useEffect(() => {
    if (!app || connectionState !== "connected") return;

    const hostCapabilities = app.getHostCapabilities();
    if (!hostCapabilities?.updateModelContext?.image) return;

    const container = containerRef.current;
    if (!container) return;

    let lastHash: string | null = null;
    let failures = 0;

    const hashString = (str: string): string => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash = hash & hash;
      }
      return hash.toString(16);
    };

    const capture = async () => {
      if (failures >= 3) return;
      const canvas = container.querySelector("canvas");
      if (!canvas) return;

      try {
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
        const currentHash = hashString(base64Data);
        if (currentHash === lastHash) return;
        lastHash = currentHash;

        await app.updateModelContext({
          content: [
            { type: "image", data: base64Data, mimeType: "image/jpeg" },
          ],
        });
        failures = 0;
      } catch {
        failures++;
      }
    };

    const intervalId = setInterval(capture, 2000);
    const initialTimeout = setTimeout(capture, 500);
    return () => {
      clearInterval(intervalId);
      clearTimeout(initialTimeout);
    };
  }, [app, connectionState]);

  const handleReconnect = useCallback(() => {
    setConnectionState("connecting");
    setErrorMessage(null);
  }, []);

  const handleOpenInBrowser = useCallback(() => {
    if (!extractedInfo?.url) return;
    if (app) app.openLink({ url: extractedInfo.url });
    else window.open(extractedInfo.url, "_blank");
  }, [app, extractedInfo]);

  const isFullscreen =
    hostContext?.displayMode === "fullscreen" ||
    (typeof document !== "undefined" && !!document.fullscreenElement);

  const handleToggleFullscreen = useCallback(async () => {
    try {
      if (isFullscreen) {
        if (app) await app.requestDisplayMode({ mode: "inline" });
        else await document.exitFullscreen();
      } else {
        if (app) await app.requestDisplayMode({ mode: "fullscreen" });
        else await document.documentElement.requestFullscreen();
      }
    } catch (e) {
      log.warn("Fullscreen toggle failed:", e);
    }
  }, [app, isFullscreen]);

  const handleDisconnect = useCallback(() => {
    if (rfbRef.current) {
      rfbRef.current.disconnect();
      rfbRef.current = null;
      setConnectionState("disconnected");
      setErrorMessage("Disconnected. Click Reconnect to connect again.");
    }
  }, []);

  // Waiting for desktop info
  if (!extractedInfo) {
    return (
      <div className={styles.container}>
        <div className={styles.waiting}>
          <p>Waiting for desktop information...</p>
          <p className={styles.hint}>
            Use the <code>connect-desktop</code> tool with a desktop URL.
          </p>
        </div>
      </div>
    );
  }

  // CSP blocked fallback
  if (connectionState === "csp-blocked") {
    return (
      <div className={styles.container}>
        <div className={styles.desktopCard}>
          <div className={styles.desktopIcon}>
            <svg
              viewBox="0 0 24 24"
              width="64"
              height="64"
              fill="currentColor"
            >
              <path d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z" />
            </svg>
          </div>
          <h2 className={styles.desktopTitle}>{extractedInfo.name}</h2>
          <p className={styles.desktopUrl}>{extractedInfo.url}</p>
          <button className={styles.openButton} onClick={handleOpenInBrowser}>
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="currentColor"
            >
              <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
            </svg>
            Open Desktop in Browser
          </button>
        </div>
      </div>
    );
  }

  // Loading noVNC
  if (!noVncReady) {
    return (
      <div className={styles.container}>
        <div className={styles.waiting}>
          <div className={styles.spinner} />
          <p>Loading VNC library...</p>
        </div>
      </div>
    );
  }

  // Disconnected / error
  if (connectionState === "disconnected" || connectionState === "error") {
    return (
      <div className={styles.container}>
        <div className={styles.disconnected}>
          <div className={styles.icon}>
            <svg
              viewBox="0 0 24 24"
              width="48"
              height="48"
              fill="currentColor"
            >
              <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9 8h2v8H9zm4 0h2v8h-2z" />
            </svg>
          </div>
          <h2>{extractedInfo.name}</h2>
          <p className={styles.errorText}>{errorMessage}</p>
          <div className={styles.actions}>
            <button className={styles.primaryButton} onClick={handleReconnect}>
              Reconnect
            </button>
            <button
              className={styles.secondaryButton}
              onClick={handleOpenInBrowser}
            >
              Open in Browser
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Connected or connecting - VNC viewer
  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <span className={styles.desktopName}>{extractedInfo.name}</span>
        <span
          className={`${styles.status} ${connectionState === "connected" ? styles.statusConnected : styles.statusConnecting}`}
        >
          {connectionState === "connected" ? "Connected" : "Connecting..."}
        </span>
        <div className={styles.toolbarActions}>
          <button
            className={styles.toolbarButton}
            onClick={handleDisconnect}
            title="Disconnect"
            disabled={connectionState !== "connected"}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
          <button
            className={styles.toolbarButton}
            onClick={handleToggleFullscreen}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? (
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="currentColor"
              >
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="currentColor"
              >
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            )}
          </button>
          <button
            className={styles.toolbarButton}
            onClick={handleOpenInBrowser}
            title="Open in browser"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
            </svg>
          </button>
        </div>
      </div>

      <div className={styles.vncContainer}>
        {connectionState === "connecting" && (
          <div className={styles.connectingOverlay}>
            <div className={styles.spinner} />
            <p>Connecting to {extractedInfo.name}...</p>
          </div>
        )}
        <div ref={containerRef} className={styles.vncCanvas} />
      </div>
    </div>
  );
}

/**
 * Extract desktop info from tool result or direct prop.
 */
function useExtractDesktopInfo(
  toolResult: CallToolResult | null,
  desktopInfo: DesktopInfo | null,
): DesktopInfo | null {
  const [extracted, setExtracted] = useState<DesktopInfo | null>(desktopInfo);

  useEffect(() => {
    if (desktopInfo) {
      setExtracted(desktopInfo);
      return;
    }

    if (!toolResult) return;

    const textContent = toolResult.content?.find((c) => c.type === "text");
    if (!textContent || textContent.type !== "text") return;

    const text = textContent.text;
    const nameMatch = text.match(/Desktop "([^"]+)"/);
    const urlMatch = text.match(/Open in browser: (http[^\s]+)/);
    const wsUrlMatch = text.match(/WebSocket URL: (wss?[^\s]+)/);

    if (urlMatch && wsUrlMatch) {
      setExtracted({
        name: nameMatch?.[1] || "Remote Desktop",
        url: urlMatch[1],
        wsUrl: wsUrlMatch[1],
      });
    }
  }, [toolResult, desktopInfo]);

  return extracted;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ViewDesktopApp />
  </StrictMode>,
);
