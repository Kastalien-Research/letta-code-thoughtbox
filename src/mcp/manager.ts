import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ErrorCode,
  ListRootsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types";
import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";
import { settingsManager } from "../settings-manager";
import type { ExternalToolDefinition, ToolReturnContent } from "../tools/manager";
import { setDynamicTools } from "../tools/manager";
import { getVersion } from "../version";
import {
  handleElicitationRequest,
  handleSamplingRequest,
} from "./interactions";
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
    capabilities: {
      tools: {},
      sampling: { tools: {} },
      elicitation: { form: {} },
      roots: { listChanged: false },
    },
  });

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const params = request.params;
    if ("mode" in params && params.mode === "url") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "URL-based elicitation is not supported",
      );
    }
    return handleElicitationRequest(server.name, params);
  });

  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    return handleSamplingRequest(server.name, request.params);
  });

  client.setRequestHandler(ListRootsRequestSchema, async () => {
    return { roots: buildRootsList() };
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

function buildRootsList(): Array<{ uri: string; name?: string }> {
  const cwd = process.cwd();
  return [
    {
      uri: pathToFileURL(cwd).toString(),
      name: "workspace",
    },
  ];
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

function formatSamplingContentBlock(block: Record<string, unknown>): string {
  const type = typeof block.type === "string" ? block.type : "unknown";

  if (type === "text" && typeof block.text === "string") {
    return block.text;
  }

  if (type === "image" && typeof block.mimeType === "string") {
    return `[image ${block.mimeType}]`;
  }

  if (type === "audio" && typeof block.mimeType === "string") {
    return `[audio ${block.mimeType}]`;
  }

  if (type === "resource") {
    const resource =
      typeof block.resource === "object" && block.resource
        ? (block.resource as Record<string, unknown>)
        : undefined;
    const uri = typeof resource?.uri === "string" ? resource.uri : "unknown";
    if (typeof resource?.text === "string") {
      return resource.text;
    }
    return `[resource ${uri}]`;
  }

  if (type === "resource_link") {
    const uri = typeof block.uri === "string" ? block.uri : "unknown";
    return `[resource link ${uri}]`;
  }

  if (type === "tool_use") {
    const name = typeof block.name === "string" ? block.name : "unknown";
    return `[tool use ${name}]`;
  }

  if (type === "tool_result") {
    return "[tool result]";
  }

  return `[${type} content]`;
}

function formatSamplingContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part
          ? formatSamplingContentBlock(part as Record<string, unknown>)
          : String(part),
      )
      .join("\n");
  }
  if (typeof content === "object" && content) {
    return formatSamplingContentBlock(content as Record<string, unknown>);
  }
  return typeof content === "string" ? content : String(content);
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

function formatProgressUpdate(update: {
  progress: number;
  total?: number;
  message?: string;
}): string {
  const totalSuffix =
    typeof update.total === "number" ? `/${update.total}` : "";
  const message = update.message ? ` ${update.message}` : "";
  return `${update.progress}${totalSuffix}${message}`.trim();
}

function appendProgressToOutput(
  output: ToolReturnContent,
  progressLines: string[],
): ToolReturnContent {
  if (progressLines.length === 0) {
    return output;
  }
  const progressText = `Progress:\n${progressLines.map((line) => `- ${line}`).join("\n")}`;
  if (typeof output === "string") {
    const prefix = output ? `${output}\n\n` : "";
    return `${prefix}${progressText}`;
  }
  return [...output, toTextContent(progressText)];
}

async function callMcpTool(
  server: LocalMcpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolReturnContent> {
  const { client } = await getConnection(server, timeoutMs);
  const progressLines: string[] = [];
  const onprogress = (update: {
    progress: number;
    total?: number;
    message?: string;
  }) => {
    progressLines.push(formatProgressUpdate(update));
  };

  let result:
    | {
        content?: Array<Record<string, unknown>>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      }
    | undefined;

  if (client.isToolTask(toolName)) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    try {
      const stream = client.experimental.tasks.callToolStream(
        { name: toolName, arguments: args },
        CallToolResultSchema,
        { signal: abortController.signal, onprogress },
      );
      for await (const message of stream) {
        switch (message.type) {
          case "taskCreated":
            progressLines.push(`Task created: ${message.task.taskId}`);
            break;
          case "taskStatus":
            progressLines.push(`Task status: ${message.task.status}`);
            break;
          case "result":
            result = message.result;
            break;
          case "error":
            throw message.error;
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } else {
    result = await withTimeout(
      client.callTool(
        { name: toolName, arguments: args },
        CallToolResultSchema,
        { onprogress },
      ),
      timeoutMs,
      `MCP tool ${toolName}`,
    );
  }

  if (!result) {
    throw new Error(`MCP tool ${toolName} did not return a result`);
  }

  const output = convertToolResult(result);
  if (result.isError) {
    throw new Error(toErrorMessage(output));
  }
  return appendProgressToOutput(output, progressLines);
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

  const serverTools = (response.tools as McpTool[]).map((tool) => {
    const name = makeMcpToolName(server.name, tool.name);
    return {
      name,
      description: buildToolDescription(server.name, tool),
      inputSchema: tool.inputSchema ?? DEFAULT_TOOL_SCHEMA,
      execute: async (args) =>
        callMcpTool(server, tool.name, args as Record<string, unknown>, timeoutMs),
    };
  });

  return [
    ...serverTools,
    ...buildResourceToolDefinitions(server, timeoutMs),
    ...buildPromptToolDefinitions(server, timeoutMs),
  ];
}

function buildResourceToolDefinitions(
  server: LocalMcpServerConfig,
  timeoutMs: number,
): ExternalToolDefinition[] {
  const listResourcesTool: ExternalToolDefinition = {
    name: makeMcpToolName(server.name, "resources_list"),
    description: `[MCP:${server.name}] List available resources`,
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description: "Pagination cursor from a previous resources list call",
        },
      },
    },
    execute: async (args) => {
      const { client } = await getConnection(server, timeoutMs);
      const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
      const result = await withTimeout(
        client.listResources(cursor ? { cursor } : undefined),
        timeoutMs,
        `MCP resources/list (${server.name})`,
      );
      const resources = result.resources ?? [];
      if (resources.length === 0) {
        return "No resources available.";
      }
      const lines = resources.map((resource) => {
        const description =
          typeof resource.description === "string"
            ? ` - ${resource.description}`
            : "";
        const mimeType =
          typeof resource.mimeType === "string"
            ? ` (${resource.mimeType})`
            : "";
        return `${resource.uri}${mimeType}${description}`;
      });
      if (result.nextCursor) {
        lines.push(`Next cursor: ${result.nextCursor}`);
      }
      return lines.join("\n");
    },
  };

  const listResourceTemplatesTool: ExternalToolDefinition = {
    name: makeMcpToolName(server.name, "resource_templates_list"),
    description: `[MCP:${server.name}] List resource templates`,
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description:
            "Pagination cursor from a previous resource templates list call",
        },
      },
    },
    execute: async (args) => {
      const { client } = await getConnection(server, timeoutMs);
      const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
      const result = await withTimeout(
        client.listResourceTemplates(cursor ? { cursor } : undefined),
        timeoutMs,
        `MCP resources/templates/list (${server.name})`,
      );
      const templates = result.resourceTemplates ?? [];
      if (templates.length === 0) {
        return "No resource templates available.";
      }
      const lines = templates.map((template) => {
        const description =
          typeof template.description === "string"
            ? ` - ${template.description}`
            : "";
        const mimeType =
          typeof template.mimeType === "string"
            ? ` (${template.mimeType})`
            : "";
        return `${template.uriTemplate}${mimeType}${description}`;
      });
      if (result.nextCursor) {
        lines.push(`Next cursor: ${result.nextCursor}`);
      }
      return lines.join("\n");
    },
  };

  const readResourceTool: ExternalToolDefinition = {
    name: makeMcpToolName(server.name, "resource_read"),
    description: `[MCP:${server.name}] Read a resource by URI`,
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description: "Resource URI to read",
        },
      },
      required: ["uri"],
    },
    execute: async (args) => {
      const uri = typeof args.uri === "string" ? args.uri : null;
      if (!uri) {
        throw new Error("uri is required");
      }
      const { client } = await getConnection(server, timeoutMs);
      const result = await withTimeout(
        client.readResource({ uri }),
        timeoutMs,
        `MCP resources/read (${server.name})`,
      );
      const contents = result.contents ?? [];
      if (contents.length === 0) {
        return `No contents returned for resource ${uri}`;
      }

      const blocks: Array<TextContent | ImageContent> = [];
      for (const content of contents) {
        const resourceUri =
          typeof content.uri === "string" ? content.uri : uri;
        const mimeType =
          typeof content.mimeType === "string"
            ? content.mimeType
            : "application/octet-stream";

        if (typeof content.text === "string") {
          blocks.push(toTextContent(content.text));
          continue;
        }

        if (typeof content.blob === "string") {
          if (mimeType.startsWith("image/")) {
            blocks.push(toImageContent({ data: content.blob, mimeType }));
            continue;
          }
          const size = content.blob.length;
          blocks.push(
            toTextContent(
              `[binary ${mimeType}] ${resourceUri} (${size} base64 chars)`,
            ),
          );
        }
      }

      return blocks.length === 1 ? blocks[0] : blocks;
    },
  };

  return [listResourcesTool, listResourceTemplatesTool, readResourceTool];
}

function buildPromptToolDefinitions(
  server: LocalMcpServerConfig,
  timeoutMs: number,
): ExternalToolDefinition[] {
  const listPromptsTool: ExternalToolDefinition = {
    name: makeMcpToolName(server.name, "prompts_list"),
    description: `[MCP:${server.name}] List prompt templates`,
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description: "Pagination cursor from a previous prompts list call",
        },
      },
    },
    execute: async (args) => {
      const { client } = await getConnection(server, timeoutMs);
      const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
      const result = await withTimeout(
        client.listPrompts(cursor ? { cursor } : undefined),
        timeoutMs,
        `MCP prompts/list (${server.name})`,
      );
      const prompts = result.prompts ?? [];
      if (prompts.length === 0) {
        return "No prompts available.";
      }
      const lines = prompts.map((prompt) => {
        const description =
          typeof prompt.description === "string"
            ? ` - ${prompt.description}`
            : "";
        const argsSummary = Array.isArray(prompt.arguments)
          ? ` (${prompt.arguments.map((arg) => arg.name).join(", ")})`
          : "";
        return `${prompt.name}${argsSummary}${description}`;
      });
      if (result.nextCursor) {
        lines.push(`Next cursor: ${result.nextCursor}`);
      }
      return lines.join("\n");
    },
  };

  const getPromptTool: ExternalToolDefinition = {
    name: makeMcpToolName(server.name, "prompt_get"),
    description: `[MCP:${server.name}] Render a prompt by name`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Prompt name",
        },
        arguments: {
          type: "object",
          description: "Arguments for the prompt template",
          additionalProperties: { type: "string" },
        },
      },
      required: ["name"],
    },
    execute: async (args) => {
      const name = typeof args.name === "string" ? args.name : null;
      if (!name) {
        throw new Error("name is required");
      }
      const promptArgs =
        typeof args.arguments === "object" && args.arguments
          ? (args.arguments as Record<string, string>)
          : undefined;
      const { client } = await getConnection(server, timeoutMs);
      const result = await withTimeout(
        client.getPrompt({ name, arguments: promptArgs }),
        timeoutMs,
        `MCP prompts/get (${server.name})`,
      );
      const messages = result.messages ?? [];
      if (messages.length === 0) {
        return `Prompt "${name}" returned no messages.`;
      }
      const lines = messages.map((message) => {
        const role = message.role ?? "assistant";
        const content = formatSamplingContent(message.content);
        return `${role}: ${content}`;
      });
      return lines.join("\n");
    },
  };

  return [listPromptsTool, getPromptTool];
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
