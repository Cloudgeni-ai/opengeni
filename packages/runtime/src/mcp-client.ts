import { AsyncLocalStorage } from "node:async_hooks";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { MCPServerStreamableHttp } from "@openai/agents";

type MCPServerStreamableHttpOptions = ConstructorParameters<typeof MCPServerStreamableHttp>[0];

const toolCallObservations = new AsyncLocalStorage<McpToolCallObservation>();

export class McpToolCallObservation {
  wireInvalidParams = false;
  readonly cleanups: Array<() => void> = [];

  run<T>(call: () => T): T {
    return toolCallObservations.run(this, call);
  }

  close(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
}

/**
 * MCP client protocol selection for streamable HTTP servers.
 *
 * Remote servers are reached through the MCP TypeScript SDK v2 client, which
 * speaks protocol revision 2026-07-28 and negotiates the era per server:
 * `auto` probes with `server/discover` and falls back to the 2025-era
 * `initialize` handshake when the server is a legacy one. Opengeni's own
 * first-party servers are known 2025-era servers, so they skip the probe and
 * keep their single-round-trip connect on the turn-start path.
 *
 * ChatGPT's apps server (codex_apps) also stays on the 2025 handshake: it
 * answers `server/discover`, but its `tools/list` result has no `resultType`,
 * so a 2026-07-28 client rejects every tool list and the turn silently runs
 * without any connected app.
 */
type McpClientModule = typeof import("@modelcontextprotocol/client");
let observedMcpClientModule: Promise<McpClientModule> | undefined;

function loadMcpClientModule(): Promise<McpClientModule> {
  return (observedMcpClientModule ??= import("@modelcontextprotocol/client").then((sdk) => {
    // The SDK uses Invalid params for local output-schema failures too, and
    // converts both into the same thrown error shape. Observe only a matching
    // response before the SDK handles it, without changing the message or error.
    class ObservedTransport extends sdk.StreamableHTTPClientTransport {
      private readonly toolCalls = new Map<string | number, McpToolCallObservation>();

      override onmessage: NonNullable<StreamableHTTPClientTransport["onmessage"]> = (message) => {
        if (!sdk.isJSONRPCErrorResponse(message) && !sdk.isJSONRPCResultResponse(message)) return;
        if (message.id === undefined || message.id === null) return;
        const observation = this.toolCalls.get(message.id);
        if (!observation) return;
        this.toolCalls.delete(message.id);
        observation.wireInvalidParams =
          "error" in message && message.error.code === sdk.ProtocolErrorCode.InvalidParams;
      };

      override send(...args: Parameters<StreamableHTTPClientTransport["send"]>) {
        const [message] = args;
        const scope = toolCallObservations.getStore();
        if (
          scope &&
          !Array.isArray(message) &&
          sdk.isJSONRPCRequest(message) &&
          message.method === "tools/call"
        ) {
          const { id } = message;
          scope.wireInvalidParams = false;
          this.toolCalls.set(id, scope);
          scope.cleanups.push(() => {
            if (this.toolCalls.get(id) === scope) this.toolCalls.delete(id);
          });
        }
        return super.send(...args);
      }
    }
    return { ...sdk, StreamableHTTPClientTransport: ObservedTransport };
  }));
}

export function mcpStreamableHttpClientOptions(params: {
  firstParty: boolean;
  codexApps?: boolean;
}): Pick<MCPServerStreamableHttpOptions, "mcpClientModule" | "versionNegotiation"> {
  return {
    mcpClientModule: loadMcpClientModule,
    versionNegotiation: { mode: params.firstParty || params.codexApps ? "legacy" : "auto" },
  };
}
