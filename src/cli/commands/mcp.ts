// src/cli/commands/mcp.ts
// MCP server command handlers

import type {
  CreateSseMcpServer,
  CreateStdioMcpServer,
  CreateStreamableHTTPMcpServer,
} from "@letta-ai/letta-client/resources/mcp-servers/mcp-servers";
import { getClient } from "../../agent/client";
import type { LocalMcpServerConfig } from "../../mcp/types";
import type { Buffers, Line } from "../helpers/accumulator";
import { formatErrorDetails } from "../helpers/errorFormatter";

// tiny helper for unique ids
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Helper type for command result
type CommandLine = Extract<Line, { kind: "command" }>;

// Context passed to MCP handlers
export interface McpCommandContext {
  buffersRef: { current: Buffers };
  refreshDerived: () => void;
  setCommandRunning: (running: boolean) => void;
}

// Helper to add a command result to buffers
export function addCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): string {
  const cmdId = uid("cmd");
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  buffersRef.current.order.push(cmdId);
  refreshDerived();
  return cmdId;
}

// Helper to update an existing command result
export function updateCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  cmdId: string,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): void {
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  refreshDerived();
}

// Helper to parse command line arguments respecting quoted strings
function parseCommandArgs(commandStr: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < commandStr.length; i++) {
    const char = commandStr[i];
    if (!char) continue; // Skip if undefined (shouldn't happen but type safety)

    if ((char === '"' || char === "'") && !inQuotes) {
      // Start of quoted string
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      // End of quoted string
      inQuotes = false;
      quoteChar = "";
    } else if (/\s/.test(char) && !inQuotes) {
      // Whitespace outside quotes - end of argument
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      // Regular character or whitespace inside quotes
      current += char;
    }
  }

  // Add final argument if any
  if (current) {
    args.push(current);
  }

  return args;
}

// Parse /mcp add args
interface McpAddArgs {
  transport: "http" | "sse" | "stdio";
  name: string;
  url: string | null;
  command: string | null;
  args: string[];
  headers: Record<string, string>;
  authToken: string | null;
  env: Record<string, string>;
  local: boolean;
}

function parseMcpAddArgs(parts: string[]): McpAddArgs | null {
  // Expected format: add --transport <type> <name> <url/command> [--header "key: value"]
  let transport: "http" | "sse" | "stdio" | null = null;
  let name: string | null = null;
  let url: string | null = null;
  let command: string | null = null;
  const args: string[] = [];
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};
  let authToken: string | null = null;
  let local = false;

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];

    if (part === "--local" || part === "--client") {
      local = true;
      i++;
    } else if (part === "--remote" || part === "--server") {
      local = false;
      i++;
    } else if (part === "--transport" || part === "-t") {
      i++;
      const transportValue = parts[i]?.toLowerCase();
      if (transportValue === "http" || transportValue === "streamable_http") {
        transport = "http";
      } else if (transportValue === "sse") {
        transport = "sse";
      } else if (transportValue === "stdio") {
        transport = "stdio";
      }
      i++;
    } else if (part === "--header" || part === "-h") {
      i++;
      const headerValue = parts[i];
      if (headerValue) {
        // Parse "key: value" or "key=value"
        const colonMatch = headerValue.match(/^([^:]+):\s*(.+)$/);
        const equalsMatch = headerValue.match(/^([^=]+)=(.+)$/);
        if (colonMatch?.[1] && colonMatch[2]) {
          headers[colonMatch[1].trim()] = colonMatch[2].trim();
        } else if (equalsMatch?.[1] && equalsMatch[2]) {
          headers[equalsMatch[1].trim()] = equalsMatch[2].trim();
        }
      }
      i++;
    } else if (part === "--auth" || part === "-a") {
      i++;
      authToken = parts[i] || null;
      i++;
    } else if (part === "--env" || part === "-e") {
      i++;
      const envValue = parts[i];
      if (envValue) {
        const [key, ...rest] = envValue.split("=");
        if (key && rest.length > 0) {
          env[key.trim()] = rest.join("=").trim();
        }
      }
      i++;
    } else if (!name) {
      name = part || null;
      i++;
    } else if (!url && transport !== "stdio") {
      url = part || null;
      i++;
    } else if (!command && transport === "stdio") {
      command = part || null;
      i++;
    } else if (transport === "stdio" && part) {
      // Collect remaining parts as args for stdio
      args.push(part);
      i++;
    } else {
      i++;
    }
  }

  if (!transport || !name) {
    return null;
  }

  if (transport !== "stdio" && !url) {
    return null;
  }

  if (transport === "stdio" && !command) {
    return null;
  }

  return {
    transport,
    name,
    url: url || null,
    command: command || null,
    args,
    headers,
    authToken: authToken || null,
    env,
    local,
  };
}

// /mcp add --transport <type> <name> <url/command> [options]
export async function handleMcpAdd(
  ctx: McpCommandContext,
  msg: string,
  commandStr: string,
): Promise<void> {
  // Parse the full command string respecting quotes
  const parts = parseCommandArgs(commandStr);
  const args = parseMcpAddArgs(parts);

  if (!args) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      'Usage: /mcp add --transport <http|sse|stdio> <name> <url|command> [--header "key: value"] [--auth token] [--local]\n\nExamples:\n  /mcp add --transport http notion https://mcp.notion.com/mcp\n  /mcp add --transport http secure-api https://api.example.com/mcp --header "Authorization: Bearer token"\n  /mcp add --local --transport stdio my-server "./mcp-server" --env "API_KEY=token"',
      false,
    );
    return;
  }

  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Creating MCP server "${args.name}"...`,
    false,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    if (args.local) {
      const {
        addLocalMcpServer,
        buildLocalMcpConfig,
        refreshMcpTools,
      } = await import("../../mcp/manager");

      const config = buildLocalMcpConfig({
        name: args.name,
        transport: args.transport === "http" ? "streamable_http" : args.transport,
        url: args.url,
        command: args.command,
        args: args.args,
        headers: args.headers,
        authToken: args.authToken,
        env: args.env,
      });

      addLocalMcpServer(config);
      const refresh = await refreshMcpTools();
      const serverStatus = refresh.servers.find(
        (server) => server.name === args.name,
      );
      const toolCount = serverStatus?.toolCount ?? 0;

      if (serverStatus?.error) {
        updateCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          cmdId,
          msg,
          `Saved local MCP server "${args.name}" (${config.transport})\nWarning: ${serverStatus.error}\nLoaded ${toolCount} tool${toolCount === 1 ? "" : "s"} from cache`,
          true,
        );
      } else {
        updateCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          cmdId,
          msg,
          `Saved local MCP server "${args.name}" (${config.transport})\nLoaded ${toolCount} tool${toolCount === 1 ? "" : "s"} from server`,
          true,
        );
      }

      return;
    }

    const client = await getClient();

    let config:
      | CreateStreamableHTTPMcpServer
      | CreateSseMcpServer
      | CreateStdioMcpServer;

    if (args.transport === "http") {
      if (!args.url) {
        throw new Error("URL is required for HTTP transport");
      }
      config = {
        mcp_server_type: "streamable_http",
        server_url: args.url,
        auth_token: args.authToken,
        custom_headers:
          Object.keys(args.headers).length > 0 ? args.headers : null,
      };
    } else if (args.transport === "sse") {
      if (!args.url) {
        throw new Error("URL is required for SSE transport");
      }
      config = {
        mcp_server_type: "sse",
        server_url: args.url,
        auth_token: args.authToken,
        custom_headers:
          Object.keys(args.headers).length > 0 ? args.headers : null,
      };
    } else {
      // stdio
      if (!args.command) {
        throw new Error("Command is required for stdio transport");
      }
      config = {
        mcp_server_type: "stdio",
        command: args.command,
        args: args.args,
      };
    }

    const server = await client.mcpServers.create({
      server_name: args.name,
      config,
    });

    if (!server.id) {
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created MCP server "${args.name}" but server ID not available`,
        false,
      );
      return;
    }

    // Auto-refresh to fetch tools from the MCP server
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Created MCP server "${args.name}" (${server.mcp_server_type})\nID: ${server.id}\nFetching tools from server...`,
      false,
      "running",
    );

    try {
      await client.mcpServers.refresh(server.id);

      // Get tool count
      const tools = await client.mcpServers.tools.list(server.id);

      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created MCP server "${args.name}" (${server.mcp_server_type})\nID: ${server.id}\nLoaded ${tools.length} tool${tools.length === 1 ? "" : "s"} from server`,
        true,
      );
    } catch (refreshErr) {
      // If refresh fails, still show success but warn about tools
      const errorMsg =
        refreshErr instanceof Error ? refreshErr.message : "Unknown error";
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created MCP server "${args.name}" (${server.mcp_server_type})\nID: ${server.id}\nWarning: Could not fetch tools - ${errorMsg}\nUse /mcp and press R to refresh manually.`,
        true,
      );
    }
  } catch (error) {
    const errorDetails = formatErrorDetails(error, "");
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Failed: ${errorDetails}`,
      false,
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

function formatLocalServerTarget(server: LocalMcpServerConfig): string {
  if (server.transport === "stdio") {
    const args = server.args?.length ? ` ${server.args.join(" ")}` : "";
    return `${server.command ?? ""}${args}`.trim() || "stdio";
  }
  return server.url ?? "unknown";
}

export async function handleMcpListLocal(
  ctx: McpCommandContext,
  msg: string,
  commandStr: string,
): Promise<void> {
  const parts = parseCommandArgs(commandStr);
  if (parts.includes("--help") || parts.includes("-h")) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /mcp list\nLists local MCP servers configured for the CLI.",
      true,
    );
    return;
  }

  const { listLocalMcpServers } = await import("../../mcp/manager");
  const servers = listLocalMcpServers();

  if (servers.length === 0) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "No local MCP servers configured.\nUse /mcp add --local to add one.",
      true,
    );
    return;
  }

  const lines = servers.map((server) => {
    const target = formatLocalServerTarget(server);
    const status = server.enabled === false ? " (disabled)" : "";
    return `- ${server.name} · ${server.transport} · ${target}${status}`;
  });

  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Local MCP servers:\n${lines.join("\n")}`,
    true,
  );
}

export async function handleMcpRemoveLocal(
  ctx: McpCommandContext,
  msg: string,
  commandStr: string,
): Promise<void> {
  const parts = parseCommandArgs(commandStr);
  const name = parts[0];
  if (!name) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /mcp remove <name>",
      false,
    );
    return;
  }

  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Removing local MCP server "${name}"...`,
    false,
    "running",
  );
  ctx.setCommandRunning(true);

  try {
    const { refreshMcpTools, removeLocalMcpServer } = await import(
      "../../mcp/manager"
    );
    const removed = await removeLocalMcpServer(name);

    if (!removed) {
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Local MCP server "${name}" not found.`,
        false,
      );
      return;
    }

    await refreshMcpTools();

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Removed local MCP server "${name}".`,
      true,
    );
  } catch (error) {
    const errorDetails = formatErrorDetails(error, "");
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Failed: ${errorDetails}`,
      false,
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

export async function handleMcpRefreshLocal(
  ctx: McpCommandContext,
  msg: string,
): Promise<void> {
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Refreshing local MCP tools...",
    false,
    "running",
  );
  ctx.setCommandRunning(true);

  try {
    const { refreshMcpTools } = await import("../../mcp/manager");
    const result = await refreshMcpTools();

    if (result.servers.length === 0) {
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        "No local MCP servers configured.\nUse /mcp add --local to add one.",
        true,
      );
      return;
    }

    const lines = result.servers.map((server) => {
      if (server.error) {
        return `- ${server.name}: ${server.error} (using ${server.toolCount} cached tools)`;
      }
      return `- ${server.name}: ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
    });

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Refreshed local MCP tools (${result.totalTools} total)\n${lines.join("\n")}`,
      true,
    );
  } catch (error) {
    const errorDetails = formatErrorDetails(error, "");
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Failed: ${errorDetails}`,
      false,
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

// Show usage help
export function handleMcpUsage(ctx: McpCommandContext, msg: string): void {
  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Usage: /mcp [subcommand ...]\n" +
      "  /mcp                  - Open MCP server manager\n" +
      "  /mcp add ...          - Add a new server (without OAuth)\n" +
      "  /mcp list             - List local MCP servers\n" +
      "  /mcp remove <name>    - Remove local MCP server\n" +
      "  /mcp refresh          - Refresh local MCP tools\n" +
      "  /mcp connect          - Interactive wizard with OAuth support\n\n" +
      "Examples:\n" +
      "  /mcp add --transport http notion https://mcp.notion.com/mcp\n" +
      "  /mcp add --local --transport stdio my-server ./mcp-server",
    false,
  );
}
