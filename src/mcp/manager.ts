import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";
import { settingsManager } from "../settings-manager";
import type { ExternalToolDefinition, ToolReturnContent } from "../tools/manager";
import { setDynamicTools } from "../tools/manager";
import { getVersion } from "../version";
import type { LocalMcpServerConfig, LocalMcpTransport } from "./types";

type McpTransport =
  | StreamableHTTPClientTransport
  | SSEClientTransport
  | StdioClientTransport;

type McpConnection = {
  client: Client;
  transport: McpTransport;
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpServerStatus = {
  name: string;
  toolCount: number;
  error?: string;
};

export type McpRefreshResult = {
  servers: McpServerStatus[];
  totalTools: number;
};

const CLIENT_INFO = {
  name: "Letta Code MCP",
  version: getVersion(),
};

const DEFAULT_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
};

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

const connections = new Map<string, McpConnection>();
const pendingConnections = new Map<string, Promise<McpConnection>>();
const toolCache = new Map<string, ExternalToolDefinition[]>();

function getServerKey(server: LocalMcpServerConfig): string {
  return server.name;
}

function sanitizeToolPart(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "tool";
  const sanitized = trimmed
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "tool";
}

function makeMcpToolName(serverName: string, toolName: string): string {
  const serverPart = sanitizeToolPart(serverName);
  const toolPart = sanitizeToolPart(toolName);
  const base = `mcp_${serverPart}_${toolPart}`;
  if (base.length <= 64) {
    return base;
  }

  const hash = createHash("sha256")
    .update(`${serverName}:${toolName}`)
    .digest("hex")
    .slice(0, 8);
  const maxPrefix = Math.max(1, 64 - hash.length - 1);
  const prefix = base.slice(0, maxPrefix).replace(/_+$/g, "");
  return `${prefix}_${hash}`;
}

function getDefaultHeaders(server: LocalMcpServerConfig): Record<string, string> {
  const headers: Record<string, string> = { ...(server.headers ?? {}) };
  const hasAuthHeader =
    Object.keys(headers).some((key) => key.toLowerCase() === "authorization");

  if (server.authToken && !hasAuthHeader) {
    headers.Authorization = `Bearer ${server.authToken}`;
  }

  return headers;
}

function buildTransport(server: LocalMcpServerConfig): McpTransport {
  if (server.transport === "stdio") {
    if (!server.command) {
      throw new Error("Missing command for stdio MCP server");
    }
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: server.env,
    });
  }

  if (!server.url) {
    throw new Error("Missing URL for MCP server");
  }

  const url = new URL(server.url);
  const headers = getDefaultHeaders(server);
  const requestInit = Object.keys(headers).length
    ? { headers }
    : undefined;

  if (server.transport === "sse") {
    return new SSEClientTransport(url, { requestInit });
  }

  return new StreamableHTTPClientTransport(url, { requestInit });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function createConnection(
  server: LocalMcpServerConfig,
  timeoutMs: number,
): Promise<McpConnection> {
  const transport = buildTransport(server);
  const client = new Client(CLIENT_INFO, {
    capabilities: { tools: {} },
  });

  await withTimeout(client.connect(transport), timeoutMs, "MCP connect");
  return { client, transport };
}

async function getConnection(
  server: LocalMcpServerConfig,
  timeoutMs: number,
): Promise<McpConnection> {
  const key = getServerKey(server);
  const existing = connections.get(key);
  if (existing) {
    return existing;
  }

  const pending = pendingConnections.get(key);
  if (pending) {
    return pending;
  }

  const connectPromise = createConnection(server, timeoutMs)
    .then((connection) => {
      connections.set(key, connection);
      return connection;
    })
    .finally(() => {
      pendingConnections.delete(key);
    });

  pendingConnections.set(key, connectPromise);
  return connectPromise;
}

async function closeConnection(serverName: string): Promise<void> {
  const connection = connections.get(serverName);
  if (!connection) return;
  connections.delete(serverName);
  try {
    await connection.client.close();
  } catch {
    // Ignore close errors
  }
}

function buildToolDescription(
  serverName: string,
  tool: McpTool,
): string {
  const base = tool.description?.trim();
  const suffix = base ? ` ${base}` : "";
  return `[MCP:${serverName}]${suffix}`.trim();
}

function toTextContent(text: string): TextContent {
  return { type: "text", text };
}

function toImageContent(block: { data: string; mimeType: string }): ImageContent {
  return {
    type: "image",
    source: {
      type: "base64",
      data: block.data,
      media_type: block.mimeType,
    },
  };
}

function formatContentBlock(block: Record<string, unknown>): TextContent | ImageContent {
  const type = typeof block.type === "string" ? block.type : "unknown";

  if (type === "text" && typeof block.text === "string") {
    return toTextContent(block.text);
  }

  if (
    type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  ) {
    return toImageContent({ data: block.data, mimeType: block.mimeType });
  }

  if (type === "resource_link") {
    const uri = typeof block.uri === "string" ? block.uri : "unknown";
    const description =
      typeof block.description === "string" ? ` ${block.description}` : "";
    return toTextContent(`[resource link] ${uri}${description}`);
  }

  if (type === "resource" && typeof block.resource === "object" && block.resource) {
    const resource = block.resource as Record<string, unknown>;
    const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
    if (typeof resource.text === "string") {
      return toTextContent(resource.text);
    }
    return toTextContent(`[resource] ${uri}`);
  }

  if (type === "audio") {
    const mimeType =
      typeof block.mimeType === "string" ? block.mimeType : "audio/unknown";
    return toTextContent(`[audio ${mimeType}]`);
  }

  return toTextContent(`[${type} content]`);
}

function convertToolResult(result: {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
}): ToolReturnContent {
  if (result.structuredContent) {
    return JSON.stringify(result.structuredContent, null, 2);
  }

  const content = result.content ?? [];
  if (content.length === 0) {
    return "";
  }

  return content.map(formatContentBlock);
}

function toErrorMessage(output: ToolReturnContent): string {
  if (typeof output === "string") {
    return output || "MCP tool error";
  }
  const text = output
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return text || "MCP tool error";
}

async function callMcpTool(
  server: LocalMcpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolReturnContent> {
  const { client } = await getConnection(server, timeoutMs);
  const result = await withTimeout(
    client.callTool({ name: toolName, arguments: args }),
    timeoutMs,
    `MCP tool ${toolName}`,
  );
  const output = convertToolResult(result);
  if (result.isError) {
    throw new Error(toErrorMessage(output));
  }
  return output;
}

async function loadServerTools(
  server: LocalMcpServerConfig,
  timeoutMs: number,
): Promise<ExternalToolDefinition[]> {
  const { client } = await getConnection(server, timeoutMs);
  const response = await withTimeout(
    client.listTools(),
    timeoutMs,
    `MCP listTools (${server.name})`,
  );

  return (response.tools as McpTool[]).map((tool) => {
    const name = makeMcpToolName(server.name, tool.name);
    return {
      name,
      description: buildToolDescription(server.name, tool),
      inputSchema: tool.inputSchema ?? DEFAULT_TOOL_SCHEMA,
      execute: async (args) =>
        callMcpTool(server, tool.name, args as Record<string, unknown>, timeoutMs),
    };
  });
}

function normalizeServerConfig(
  server: LocalMcpServerConfig,
): LocalMcpServerConfig {
  return {
    ...server,
    enabled: server.enabled ?? true,
  };
}

export function listLocalMcpServers(): LocalMcpServerConfig[] {
  return settingsManager.getSetting("mcpServers") ?? [];
}

export function addLocalMcpServer(config: LocalMcpServerConfig): void {
  const servers = listLocalMcpServers();
  if (servers.some((server) => server.name === config.name)) {
    throw new Error(`MCP server "${config.name}" already exists`);
  }
  settingsManager.updateSettings({
    mcpServers: [...servers, normalizeServerConfig(config)],
  });
}

export async function removeLocalMcpServer(name: string): Promise<boolean> {
  const servers = listLocalMcpServers();
  const nextServers = servers.filter((server) => server.name !== name);
  if (nextServers.length === servers.length) {
    return false;
  }
  settingsManager.updateSettings({ mcpServers: nextServers });
  toolCache.delete(name);
  await closeConnection(name);
  return true;
}

export async function refreshMcpTools(
  options: { timeoutMs?: number } = {},
): Promise<McpRefreshResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const servers = listLocalMcpServers().map(normalizeServerConfig);
  const activeServers = servers.filter((server) => server.enabled !== false);
  const activeKeys = new Set(activeServers.map((server) => server.name));

  for (const cachedKey of toolCache.keys()) {
    if (!activeKeys.has(cachedKey)) {
      toolCache.delete(cachedKey);
    }
  }

  const results: McpServerStatus[] = [];

  for (const server of activeServers) {
    try {
      const tools = await loadServerTools(server, timeoutMs);
      toolCache.set(server.name, tools);
      results.push({ name: server.name, toolCount: tools.length });
    } catch (error) {
      await closeConnection(server.name);
      const message = error instanceof Error ? error.message : String(error);
      const cached = toolCache.get(server.name);
      results.push({
        name: server.name,
        toolCount: cached?.length ?? 0,
        error: message,
      });
    }
  }

  const dynamicTools = Array.from(toolCache.values()).flat();
  setDynamicTools(dynamicTools);

  return {
    servers: results,
    totalTools: dynamicTools.length,
  };
}

export function buildLocalMcpConfig(params: {
  name: string;
  transport: LocalMcpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[];
  headers?: Record<string, string>;
  authToken?: string | null;
  env?: Record<string, string>;
}): LocalMcpServerConfig {
  return {
    name: params.name,
    transport: params.transport,
    url: params.url ?? undefined,
    command: params.command ?? undefined,
    args: params.args ?? [],
    headers: params.headers,
    authToken: params.authToken ?? undefined,
    env: params.env,
    enabled: true,
  };
}
