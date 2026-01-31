import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types";
import type {
  CreateMessageRequestParams,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ElicitRequestParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types";

export type McpElicitationHandler = (request: {
  serverName: string;
  params: ElicitRequestParams;
}) => Promise<ElicitResult>;

export type McpSamplingHandler = (request: {
  serverName: string;
  params: CreateMessageRequestParams;
}) => Promise<CreateMessageResult | CreateMessageResultWithTools>;

export type McpInteractionHandlers = {
  onElicitation?: McpElicitationHandler;
  onSampling?: McpSamplingHandler;
};

let handlers: McpInteractionHandlers = {};

export function setMcpInteractionHandlers(
  nextHandlers: McpInteractionHandlers | null,
): void {
  handlers = nextHandlers ?? {};
}

export async function handleElicitationRequest(
  serverName: string,
  params: ElicitRequestParams,
): Promise<ElicitResult> {
  if (handlers.onElicitation) {
    return handlers.onElicitation({ serverName, params });
  }
  return { action: "cancel" };
}

export async function handleSamplingRequest(
  serverName: string,
  params: CreateMessageRequestParams,
): Promise<CreateMessageResult | CreateMessageResultWithTools> {
  if (handlers.onSampling) {
    return handlers.onSampling({ serverName, params });
  }
  throw new McpError(
    ErrorCode.MethodNotFound,
    "Sampling not supported in this session",
  );
}
