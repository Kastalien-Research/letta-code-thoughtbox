import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { CreateMessageRequestParams } from "@modelcontextprotocol/sdk/types";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

const SOLID_LINE = "─";

interface McpSamplingDialogProps {
  serverName: string;
  request: CreateMessageRequestParams;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

function formatSamplingBlock(block: Record<string, unknown>): string {
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
          ? formatSamplingBlock(part as Record<string, unknown>)
          : String(part),
      )
      .join("\n");
  }
  if (typeof content === "object" && content) {
    return formatSamplingBlock(content as Record<string, unknown>);
  }
  return typeof content === "string" ? content : String(content);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function McpSamplingDialog({
  serverName,
  request,
  onSubmit,
  onCancel,
}: McpSamplingDialogProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [responseText, setResponseText] = useState("");
  const [error, setError] = useState("");

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  const summary = useMemo(() => {
    const messages = request.messages ?? [];
    const lastMessage = messages[messages.length - 1];
    const lastContent = lastMessage ? formatSamplingContent(lastMessage.content) : "";
    const lastSummary = lastMessage
      ? `${lastMessage.role}: ${truncateText(lastContent, 120)}`
      : "No messages provided.";
    const toolNames = request.tools?.map((tool) => tool.name) ?? [];
    return {
      messageCount: messages.length,
      lastSummary,
      toolNames,
    };
  }, [request]);

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Response cannot be empty");
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> MCP sampling"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Sampling requested by {serverName}
        </Text>
        <Text dimColor>
          {"  "}Messages: {summary.messageCount}
        </Text>
        {request.systemPrompt && (
          <Text dimColor>
            {"  "}System prompt:{" "}
            {truncateText(request.systemPrompt, terminalWidth - 18)}
          </Text>
        )}
        <Text dimColor>{"  "}Last message: {summary.lastSummary}</Text>
        {summary.toolNames.length > 0 && (
          <Text dimColor>
            {"  "}Tools available: {summary.toolNames.join(", ")}
          </Text>
        )}
      </Box>

      <Box flexDirection="row">
        <Text color={colors.selector.itemHighlighted}>{"> "}</Text>
        <PasteAwareTextInput
          value={responseText}
          onChange={setResponseText}
          onSubmit={handleSubmit}
          placeholder="Type the assistant response"
        />
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">
            {"  "}
            {error}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{"  "}Enter to submit · Esc cancel</Text>
      </Box>
    </Box>
  );
}
