export type LocalMcpTransport = "streamable_http" | "sse" | "stdio";

export interface LocalMcpServerConfig {
  name: string;
  transport: LocalMcpTransport;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  authToken?: string;
  env?: Record<string, string>;
  enabled?: boolean;
}
