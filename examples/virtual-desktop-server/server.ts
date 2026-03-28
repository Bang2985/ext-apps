/**
 * MCP Server for virtual desktops.
 *
 * Tools:
 * - connect-desktop: Connect to any remote desktop via noVNC (URL-based)
 * - list-desktops: List Docker-managed virtual desktop containers
 * - create-desktop: Create a new virtual desktop container
 * - view-desktop: View a Docker-managed virtual desktop (has MCP App UI)
 * - shutdown-desktop: Stop and remove a virtual desktop container
 * - open-home-folder: Open the desktop's home folder on the host
 * - take-screenshot: Take a screenshot of a virtual desktop
 * - exec: Execute a command inside a virtual desktop container
 * - click / type-text / press-key / move-mouse / scroll: Input automation
 * - resize-desktop: Resize a virtual desktop by restarting VNC
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { startServer } from "./server-utils.js";
import {
  listDesktops,
  createDesktop,
  getDesktop,
  shutdownDesktop,
  checkDocker,
  getPortConfig,
  waitForVncReady,
  CONTAINER_PREFIX,
  DESKTOP_VARIANTS,
  DEFAULT_VARIANT,
  DEFAULT_RESOLUTION,
  VIRTUAL_DESKTOPS_DIR,
  type DesktopInfo,
  type DesktopVariant,
} from "./src/docker.js";

const DIST_DIR = path.join(import.meta.dirname, "dist");

// ============================================================================
// Schemas
// ============================================================================

const ResolutionSchema = z.object({
  width: z.number().min(640).max(3840).describe("Width in pixels"),
  height: z.number().min(480).max(2160).describe("Height in pixels"),
});

const MountSchema = z.object({
  hostPath: z.string().describe("Path on the host machine"),
  containerPath: z.string().describe("Path inside the container"),
  readonly: z.boolean().optional().describe("Mount as read-only"),
});

const DEFAULT_DESKTOP_NAME = "my-desktop";

const ConnectDesktopInputSchema = z.object({
  url: z
    .string()
    .describe(
      "Base URL of the desktop (e.g. https://my-webtop.example.com:3001). " +
        "The websocket URL will be derived by replacing https→wss and appending the websocketPath.",
    ),
  password: z.string().optional().describe("VNC password (if required)"),
  websocketPath: z
    .string()
    .default("/websockify")
    .describe("Path to the websockify endpoint (default: /websockify)"),
  name: z
    .string()
    .default("Remote Desktop")
    .describe("Display name for the desktop"),
});

const CreateDesktopInputSchema = z.object({
  name: z
    .string()
    .default(DEFAULT_DESKTOP_NAME)
    .describe(
      `Name for the desktop (will be sanitized and prefixed with '${CONTAINER_PREFIX}')`,
    ),
  variant: z
    .enum(DESKTOP_VARIANTS)
    .default(DEFAULT_VARIANT)
    .describe(
      `Desktop variant. Options: xfce (lightweight), webtop-ubuntu-xfce, webtop-alpine-xfce`,
    ),
  resolution: ResolutionSchema.optional().describe(
    `Initial resolution (default: ${DEFAULT_RESOLUTION.width}x${DEFAULT_RESOLUTION.height})`,
  ),
  commands: z
    .array(z.string())
    .optional()
    .describe("Commands to run on startup"),
  mounts: z.array(MountSchema).optional().describe("Additional volume mounts"),
});

const ViewDesktopInputSchema = z.object({
  name: z
    .string()
    .default(DEFAULT_DESKTOP_NAME)
    .describe("Name of the desktop to view (e.g., 'my-desktop')"),
});

const ShutdownDesktopInputSchema = z.object({
  name: z.string().describe("Name of the desktop to shutdown"),
  cleanup: z
    .boolean()
    .optional()
    .describe(
      "Delete the desktop's data directory (default: false, preserves data)",
    ),
});

// ============================================================================
// Helpers
// ============================================================================

function formatDesktopInfo(desktop: DesktopInfo): string {
  const lines = [
    `Name: ${desktop.name}`,
    `Status: ${desktop.status}`,
    `Container ID: ${desktop.containerId}`,
    `Variant: ${desktop.variant}`,
    `Resolution: ${desktop.resolution.width}x${desktop.resolution.height}`,
    `Commands: ${desktop.commands.join(", ")}`,
  ];

  if (desktop.port) {
    lines.push(`Port: ${desktop.port}`);
    lines.push(`URL: http://localhost:${desktop.port}`);
  }

  lines.push(`Created: ${desktop.createdAt}`);

  return lines.join("\n");
}

/** Helper to check Docker and return an error result if unavailable. */
async function requireDocker(): Promise<CallToolResult | null> {
  if (await checkDocker()) return null;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "Docker is not available. Please ensure Docker is installed and running.",
      },
    ],
  };
}

type DesktopResult =
  | { ok: true; desktop: DesktopInfo; containerName: string }
  | { ok: false; error: CallToolResult };

/** Helper to look up a running desktop or return an error result. */
async function requireRunningDesktop(name: string): Promise<DesktopResult> {
  const dockerErr = await requireDocker();
  if (dockerErr) return { ok: false, error: dockerErr };

  const desktop = await getDesktop(name);
  if (!desktop) {
    const baseName = name.startsWith(CONTAINER_PREFIX)
      ? name.slice(CONTAINER_PREFIX.length)
      : name;
    return {
      ok: false,
      error: {
        isError: true,
        content: [
          {
            type: "text",
            text: `Desktop "${name}" not found. Create it first with: create-desktop { "name": "${baseName}" }. Or use list-desktops to see available desktops.`,
          },
        ],
      },
    };
  }

  if (desktop.status !== "running") {
    return {
      ok: false,
      error: {
        isError: true,
        content: [
          {
            type: "text",
            text: `Desktop "${name}" is not running (status: ${desktop.status}). Please start it first.`,
          },
        ],
      },
    };
  }

  return { ok: true, desktop, containerName: desktop.name };
}

// ============================================================================
// Server
// ============================================================================

export function createVirtualDesktopServer(): McpServer {
  const server = new McpServer({
    name: "Virtual Desktop Server",
    version: "0.2.0",
  });

  const viewDesktopResourceUri = "ui://view-desktop/mcp-app.html";

  // CSP configuration shared by connect-desktop and view-desktop
  const viewDesktopCsp = {
    resourceDomains: ["https://cdn.jsdelivr.net"],
    connectDomains: [
      "ws://*",
      "wss://*",
      "https://cdn.jsdelivr.net",
    ],
  };

  // ==================== ConnectDesktop (URL-based, no Docker) ====================
  registerAppTool(
    server,
    "connect-desktop",
    {
      title: "Connect Desktop",
      description:
        "Connect to a remote desktop via noVNC given its URL. " +
        "Works with any webtop or VNC server that exposes a websockify endpoint over HTTP(S). " +
        "To create a local Docker desktop instead, use create-desktop then view-desktop.",
      inputSchema: ConnectDesktopInputSchema.shape,
      _meta: { ui: { resourceUri: viewDesktopResourceUri } },
    },
    async (args: {
      url: string;
      password?: string;
      websocketPath: string;
      name: string;
    }): Promise<CallToolResult> => {
      const baseUrl = args.url.replace(/\/+$/, "");
      const wsUrl =
        baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:") +
        args.websocketPath;

      try {
        await fetch(baseUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Cannot reach ${baseUrl}. Make sure the desktop is running and accessible.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `Desktop "${args.name}" is reachable.`,
              ``,
              `Open in browser: ${baseUrl}`,
              `WebSocket URL: ${wsUrl}`,
            ].join("\n"),
          },
        ],
        structuredContent: {
          name: args.name,
          url: baseUrl,
          wsUrl,
          password: args.password ?? "",
        },
      };
    },
  );

  // ==================== ListDesktops ====================
  server.tool(
    "list-desktops",
    "List all Docker-managed virtual desktop containers. Use create-desktop to create new ones, view-desktop to connect, shutdown-desktop to remove.",
    {},
    async (): Promise<CallToolResult> => {
      const dockerErr = await requireDocker();
      if (dockerErr) return dockerErr;

      const desktops = await listDesktops();

      if (desktops.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No virtual desktops found. Use create-desktop to create one.",
            },
          ],
        };
      }

      const text = desktops
        .map((d, i) => `[${i + 1}] ${formatDesktopInfo(d)}`)
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${desktops.length} virtual desktop(s):\n\n${text}`,
          },
        ],
      };
    },
  );

  // ==================== CreateDesktop ====================
  server.tool(
    "create-desktop",
    "Create a new virtual desktop container via Docker. After creation, use view-desktop to open the noVNC viewer. Use list-desktops to see existing desktops, shutdown-desktop to remove them. To connect to an existing remote desktop by URL instead, use connect-desktop.",
    CreateDesktopInputSchema.shape,
    async (args): Promise<CallToolResult> => {
      const dockerErr = await requireDocker();
      if (dockerErr) return dockerErr;

      try {
        const result = await createDesktop({
          name: args.name,
          variant: args.variant,
          resolution: args.resolution,
          commands: args.commands,
          mounts: args.mounts,
        });

        return {
          content: [
            {
              type: "text",
              text: [
                `Virtual desktop created successfully!`,
                ``,
                `Name: ${result.name}`,
                `Container ID: ${result.containerId}`,
                `Port: ${result.port}`,
                `URL: ${result.url}`,
                ``,
                `The desktop is starting up. Use view-desktop to connect.`,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to create desktop: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ==================== ViewDesktop (Docker) ====================
  registerAppTool(
    server,
    "view-desktop",
    {
      title: "View Desktop",
      description:
        "View and interact with a Docker-managed virtual desktop via noVNC. " +
        "The desktop must be created first with create-desktop. " +
        "Use take-screenshot, click, type-text, press-key, exec to interact programmatically. " +
        "To connect to a remote desktop by URL instead, use connect-desktop.",
      inputSchema: ViewDesktopInputSchema.shape,
      _meta: { ui: { resourceUri: viewDesktopResourceUri } },
    },
    async (args: { name: string }): Promise<CallToolResult> => {
      const result = await requireRunningDesktop(args.name);
      if (!result.ok) return result.error;
      const { desktop } = result;

      if (!desktop.port) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Desktop "${args.name}" does not have a port assigned. This may indicate a configuration issue.`,
            },
          ],
        };
      }

      const vncReady = await waitForVncReady(desktop.port);
      if (!vncReady) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Desktop "${args.name}" container is running but VNC endpoint is not responding on port ${desktop.port}. The desktop may still be starting up - try again in a few seconds.`,
            },
          ],
        };
      }

      const url = `http://localhost:${desktop.port}`;
      const wsUrl = `ws://localhost:${desktop.port}/websockify`;
      const portConfig = getPortConfig(desktop.variant as DesktopVariant);

      return {
        content: [
          {
            type: "text",
            text: [
              `Desktop "${desktop.name}" is ready.`,
              ``,
              `Open in browser: ${url}`,
              `WebSocket URL: ${wsUrl}`,
              ``,
              `Status: ${desktop.status}`,
              `Variant: ${desktop.variant}`,
              `Resolution: ${desktop.resolution.width}x${desktop.resolution.height}`,
            ].join("\n"),
          },
        ],
        structuredContent: {
          name: desktop.name,
          url,
          wsUrl,
          resolution: desktop.resolution,
          variant: desktop.variant,
          password: portConfig.password,
          homeFolder: path.join(VIRTUAL_DESKTOPS_DIR, desktop.name, "home"),
        },
        _meta: {},
      };
    },
  );

  // Register the shared resource for the noVNC viewer UI
  registerAppResource(
    server,
    viewDesktopResourceUri,
    viewDesktopResourceUri,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: "Remote Desktop Viewer (noVNC)",
    },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "mcp-app.html"),
        "utf-8",
      );
      return {
        contents: [
          {
            uri: viewDesktopResourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: viewDesktopCsp,
              },
            },
          },
        ],
      };
    },
  );

  // ==================== ShutdownDesktop ====================
  server.tool(
    "shutdown-desktop",
    "Stop and remove a Docker-managed virtual desktop container. Use list-desktops to see available desktops. Use create-desktop to create new ones.",
    ShutdownDesktopInputSchema.shape,
    async (args): Promise<CallToolResult> => {
      const dockerErr = await requireDocker();
      if (dockerErr) return dockerErr;

      const desktop = await getDesktop(args.name);

      if (!desktop) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Desktop "${args.name}" not found. Use list-desktops to see available desktops.`,
            },
          ],
        };
      }

      const success = await shutdownDesktop(args.name, args.cleanup ?? false);

      if (success) {
        const cleanupMessage = args.cleanup
          ? " Data directory has been deleted."
          : " Data directory has been preserved.";

        return {
          content: [
            {
              type: "text",
              text: `Desktop "${args.name}" has been shut down and removed.${cleanupMessage}`,
            },
          ],
        };
      } else {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to shutdown desktop "${args.name}". Check Docker logs for details.`,
            },
          ],
        };
      }
    },
  );

  // ==================== OpenHomeFolder ====================
  const OpenHomeFolderInputSchema = z.object({
    name: z.string().describe("Name of the desktop"),
  });

  registerAppTool(
    server,
    "open-home-folder",
    {
      title: "Open Home Folder",
      description:
        "Open a Docker-managed desktop's home folder on the host machine's file manager. The home folder is shared between the host and the container. Use create-desktop to create a desktop first.",
      inputSchema: OpenHomeFolderInputSchema.shape,
      _meta: {
        ui: {
          visibility: ["apps"],
        },
      },
    },
    async (args: { name: string }): Promise<CallToolResult> => {
      const desktop = await getDesktop(args.name);

      if (!desktop) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Desktop "${args.name}" not found. Use list-desktops to see available desktops.`,
            },
          ],
        };
      }

      const homeFolder = path.join(VIRTUAL_DESKTOPS_DIR, desktop.name, "home");

      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const platform = process.platform;
        let openCmd: string;
        if (platform === "darwin") {
          openCmd = `open "${homeFolder}"`;
        } else if (platform === "win32") {
          openCmd = `explorer "${homeFolder}"`;
        } else {
          openCmd = `xdg-open "${homeFolder}"`;
        }

        await execAsync(openCmd);

        return {
          content: [
            {
              type: "text",
              text: `Opened home folder: ${homeFolder}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to open home folder (${homeFolder}): ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ==================== TakeScreenshot ====================
  const TakeScreenshotInputSchema = z.object({
    name: z.string().describe("Name of the desktop"),
  });

  server.tool(
    "take-screenshot",
    "Take a screenshot of a Docker-managed virtual desktop and return it as an image. Requires a running desktop (use create-desktop to create one, list-desktops to see existing). Use click, type-text, press-key, exec to interact with the desktop.",
    TakeScreenshotInputSchema.shape,
    async (args): Promise<CallToolResult> => {
      const result = await requireRunningDesktop(args.name);
      if (!result.ok) return result.error;
      const { containerName } = result;

      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const { stdout } = await execAsync(
          `docker exec ${containerName} bash -c "DISPLAY=:1 scrot -o /tmp/screenshot.png && base64 /tmp/screenshot.png" 2>/dev/null || ` +
            `docker exec ${containerName} bash -c "DISPLAY=:1 import -window root /tmp/screenshot.png && base64 /tmp/screenshot.png"`,
          { maxBuffer: 50 * 1024 * 1024 },
        );

        return {
          content: [
            {
              type: "image",
              data: stdout.trim(),
              mimeType: "image/png",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to take screenshot: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ==================== Click ====================
  const ClickInputSchema = z.object({
    name: z.string().describe("Name of the desktop"),
    x: z.number().describe("X coordinate to click"),
    y: z.number().describe("Y coordinate to click"),
    button: z
      .enum(["left", "middle", "right"])
      .optional()
      .describe("Mouse button to click (default: left)"),
    clicks: z
      .number()
      .min(1)
      .max(3)
      .optional()
      .describe("Number of clicks (1=single, 2=double, 3=triple; default: 1)"),
  });

  server.tool(
    "click",
    "Click at a specific position on a Docker-managed virtual desktop. Use take-screenshot first to see the desktop and determine coordinates. Other input tools: type-text, press-key, move-mouse, scroll.",
    ClickInputSchema.shape,
    async (args): Promise<CallToolResult> => {
      const result = await requireRunningDesktop(args.name);
      if (!result.ok) return result.error;
      const { desktop, containerName } = result;

      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const button = args.button || "left";
        const clicks = args.clicks || 1;
        const buttonNum = button === "left" ? 1 : button === "middle" ? 2 : 3;

        const clickCmd =
          clicks === 1
            ? `xdotool mousemove ${args.x} ${args.y} click ${buttonNum}`
            : `xdotool mousemove ${args.x} ${args.y} click --repeat ${clicks} --delay 100 ${buttonNum}`;

        await execAsync(
          `docker exec ${containerName} bash -c "DISPLAY=:1 ${clickCmd}"`,
        );

        return {
          content: [
            {
              type: "text",
              text: `Clicked ${button} button${clicks > 1 ? ` ${clicks} times` : ""} at (${args.x}, ${args.y}) on ${desktop.name}.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to click: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ==================== TypeText ====================
  const TypeTextInputSchema = z.object({
    name: z.string().describe("Name of the desktop"),
    text: z.string().describe("Text to type"),
    delay: z
      .number()
      .min(0)
      .max(1000)
      .optional()
      .describe("Delay between keystrokes in milliseconds (default: 12)"),
  });

  server.tool(
    "type-text",
    "Type text on a Docker-managed virtual desktop (simulates keyboard input). Use click to focus an input field first. Use press-key for special keys (Return, Tab, etc.). Use take-screenshot to see the result.",
    TypeTextInputSchema.shape,
    async (args): Promise<CallToolResult> => {
      const result = await requireRunningDesktop(args.name);
      if (!result.ok) return result.error;
      const { desktop, containerName } = result;

      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const delay = args.delay ?? 12;
        const escapedText = args.text.replace(/'/g, "'\\''");
        await execAsync(
          `docker exec ${containerName} bash -c "DISPLAY=:1 xdotool type --clearmodifiers --delay ${delay} '${escapedText}'"`,
        );

        return {
          content: [
            {
              type: "text",
              text: `Typed "${args.text.length > 50 ? args.text.substring(0, 50) + "..." : args.text}" on ${desktop.name}.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to type text: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ==================== PressKey ====================
  const PressKeyInputSchema = z.object({
    name: z.string().describe("Name of the desktop"),
    key: z
      .string()
      .describe(
        "Key to press (e.g., 'Return', 'Tab', 'Escape', 'ctrl+c', 'alt+F4', 'super')",
      ),
  });

  server.tool(
    "press-key",
    "Press a key or key combination on a Docker-managed virtual desktop. Use type-text for typing strings, click to position the cursor first. Use take-screenshot to verify the result.",
    PressKeyInputSchema.shape,
    async (args): Promise<CallToolResult> => {
      const result = await requireRunningDesktop(args.name);
      if (!result.ok) return result.error;
      const { desktop, containerName } = result;

      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        await execAsync(
          `docker exec ${containerName} bash -c "DISPLAY=:1 xdotool key --clearmodifiers ${args.key}"`,
        );

        return {
          content: [
            {
              type: "text",
              text: `Pressed key "${args.key}" on ${desktop.name}.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to press key: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ==================== MoveMouse ====================
  const MoveMouseInputSchema = z.object({
    name: z.string().describe("Name of the desktop"),
    x: z.number().describe("X coordinate to move to"),
    y: z.number().describe("Y coordinate to move to"),
  });

  server.tool(
    "move-mouse",
    "Move the mouse cursor to a specific position on a Docker-managed virtual desktop. Use take-screenshot to determine coordinates. Use click to click at a position, scroll to scroll.",
    MoveMouseInputSchema.shape,
    async (args): Promise<CallToolResult> => {
      const result = await requireRunningDesktop(args.name);
      if (!result.ok) return result.error;
      const { desktop, containerName } = result;

      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        await execAsync(
          `docker exec ${containerName} bash -c "DISPLAY=:1 xdotool mousemove ${args.x} ${args.y}"`,
        );

        return {
          content: [
            {
              type: "text",
              text: `Moved mouse to (${args.x}, ${args.y}) on ${desktop.name}.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to move mouse: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ==================== Scroll ====================
  const ScrollInputSchema = z.object({
    name: z.string().describe("Name of the desktop"),
    direction: z
      .enum(["up", "down", "left", "right"])
      .describe("Scroll direction"),
    amount: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Number of scroll clicks (default: 3)"),
  });

  server.tool(
    "scroll",
    "Scroll on a Docker-managed virtual desktop. Use click or move-mouse to position the cursor first. Use take-screenshot to verify the result.",
    ScrollInputSchema.shape,
    async (args): Promise<CallToolResult> => {
      const result = await requireRunningDesktop(args.name);
      if (!result.ok) return result.error;
      const { desktop, containerName } = result;

      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const amount = args.amount || 3;
        const buttonMap = { up: 4, down: 5, left: 6, right: 7 };
        const button = buttonMap[args.direction];

        await execAsync(
          `docker exec ${containerName} bash -c "DISPLAY=:1 xdotool click --repeat ${amount} --delay 50 ${button}"`,
        );

        return {
          content: [
            {
              type: "text",
              text: `Scrolled ${args.direction} ${amount} times on ${desktop.name}.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to scroll: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ==================== Exec ====================
  const ExecInputSchema = z.object({
    name: z.string().describe("Name of the desktop"),
    command: z
      .string()
      .describe(
        "Command to execute (e.g., 'firefox', 'xfce4-terminal', 'ls -la ~')",
      ),
    background: z
      .boolean()
      .optional()
      .describe(
        "Run in background (default: false). Use true for GUI apps that don't exit.",
      ),
    timeout: z
      .number()
      .min(1000)
      .max(300000)
      .optional()
      .describe("Timeout in milliseconds (default: 30000, max: 300000)"),
  });

  server.tool(
    "exec",
    "Execute a command inside a Docker-managed virtual desktop container. Commands run with DISPLAY=:1 so GUI apps appear in VNC. Use background=true for GUI apps that don't exit (e.g. firefox). Use take-screenshot to see the desktop after running commands. Use create-desktop to create a desktop first.",
    ExecInputSchema.shape,
    async (args): Promise<CallToolResult> => {
      const result = await requireRunningDesktop(args.name);
      if (!result.ok) return result.error;
      const { containerName } = result;

      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const timeout = args.timeout ?? 30000;
        const background = args.background ?? false;

        const escapedCommand = args.command.replace(/'/g, "'\\''");

        const dockerCmd = background
          ? `docker exec -d ${containerName} bash -c "DISPLAY=:1 ${escapedCommand}"`
          : `docker exec ${containerName} bash -c "DISPLAY=:1 ${escapedCommand}"`;

        if (background) {
          await execAsync(dockerCmd);
          return {
            content: [
              {
                type: "text",
                text: `Started in background: ${args.command}`,
              },
            ],
          };
        } else {
          const { stdout, stderr } = await execAsync(dockerCmd, {
            timeout,
            maxBuffer: 10 * 1024 * 1024,
          });

          const output = [];
          if (stdout.trim()) output.push(`stdout:\n${stdout.trim()}`);
          if (stderr.trim()) output.push(`stderr:\n${stderr.trim()}`);

          return {
            content: [
              {
                type: "text",
                text:
                  output.length > 0
                    ? output.join("\n\n")
                    : `Command completed: ${args.command}`,
              },
            ],
          };
        }
      } catch (error: unknown) {
        const execError = error as {
          stdout?: string;
          stderr?: string;
          code?: number;
          killed?: boolean;
          message?: string;
        };

        if (execError.killed) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Command timed out after ${args.timeout ?? 30000}ms: ${args.command}`,
              },
            ],
          };
        }

        const output = [];
        if (execError.stdout?.trim())
          output.push(`stdout:\n${execError.stdout.trim()}`);
        if (execError.stderr?.trim())
          output.push(`stderr:\n${execError.stderr.trim()}`);
        if (execError.code !== undefined)
          output.push(`exit code: ${execError.code}`);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                output.length > 0
                  ? `Command failed: ${args.command}\n\n${output.join("\n\n")}`
                  : `Command failed: ${execError.message || String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ==================== ResizeDesktop ====================
  const ResizeDesktopInputSchema = z.object({
    name: z.string().describe("Name of the desktop"),
    width: z.number().min(640).max(3840).describe("New width in pixels"),
    height: z.number().min(480).max(2160).describe("New height in pixels"),
  });

  registerAppTool(
    server,
    "resize-desktop",
    {
      title: "Resize Desktop",
      description:
        "Resize a Docker-managed virtual desktop to exact dimensions by restarting VNC. This will briefly disconnect the noVNC viewer (view-desktop). Use take-screenshot to verify the new resolution.",
      inputSchema: ResizeDesktopInputSchema.shape,
      _meta: {
        ui: {
          visibility: ["apps"],
        },
      },
    },
    async (args: {
      name: string;
      width: number;
      height: number;
    }): Promise<CallToolResult> => {
      const result = await requireRunningDesktop(args.name);
      if (!result.ok) return result.error;
      const { desktop, containerName } = result;

      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const resolution = `${args.width}x${args.height}`;

        const cmd = [
          "vncserver -kill :1 2>/dev/null",
          "sleep 1",
          `vncserver :1 -depth 24 -geometry ${resolution}`,
          "sleep 2",
          "DISPLAY=:1 /headless/wm_startup.sh &",
        ].join("; ");

        await execAsync(`docker exec ${containerName} bash -c "${cmd}"`, {
          timeout: 30000,
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        return {
          content: [
            {
              type: "text",
              text: `Desktop "${desktop.name}" resized to ${resolution}. The viewer will reconnect automatically.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to resize desktop: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  return server;
}

// ============================================================================
// Server Startup
// ============================================================================

async function main() {
  if (process.argv.includes("--stdio")) {
    await createVirtualDesktopServer().connect(new StdioServerTransport());
  } else {
    const port = parseInt(process.env.PORT ?? "3002", 10);
    await startServer(createVirtualDesktopServer, {
      port,
      name: "Virtual Desktop Server",
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
