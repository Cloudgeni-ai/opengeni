import type { MCPServer } from "@openai/agents";

export const LOCAL_MCP_BRIDGE_CONTRACT_VERSION = 1 as const;

export type LocalMcpBridgeAuthority = "connection" | "host" | "none";
export type LocalMcpBridgeToolSurface = "static_reviewed" | "immutable_revision";

export type LocalMcpBridgeDestination = Readonly<{
  origin: string;
  pathPrefix: string;
}>;

/**
 * Secret-free description of an in-process provider-to-MCP adapter.
 *
 * This is observability and registration metadata, not authorization. The
 * adapter must still revalidate its named authority before each physical
 * provider request and keep credentials outside tool results and schemas.
 */
export type LocalMcpBridgeDescriptor = Readonly<{
  contractVersion: typeof LOCAL_MCP_BRIDGE_CONTRACT_VERSION;
  assurance: "static_strict" | "revision_descriptive";
  adapterId: string;
  providerId: string;
  catalogIdentity: string;
  transport: "in_process";
  authority: LocalMcpBridgeAuthority;
  toolSurface: LocalMcpBridgeToolSurface;
  mutationReplay: "safe_reads_only";
  destinations: readonly LocalMcpBridgeDestination[];
}>;

export interface LocalMcpBridgeServer extends MCPServer {
  readonly bridge: LocalMcpBridgeDescriptor;
}

export interface LocalMcpBridgeAdapter<TConfig, TContext> {
  readonly adapterId: string;
  matches(config: TConfig): boolean;
  create(config: TConfig, context: TContext): LocalMcpBridgeServer;
}

export function defineLocalMcpBridgeDescriptor(
  input: Omit<LocalMcpBridgeDescriptor, "contractVersion" | "transport" | "assurance">,
): LocalMcpBridgeDescriptor {
  const adapterId = boundedIdentity(input.adapterId, "adapterId");
  const providerId = boundedIdentity(input.providerId, "providerId");
  const catalogIdentity = boundedIdentity(input.catalogIdentity, "catalogIdentity", 512);
  if (input.destinations.length === 0 || input.destinations.length > 32) {
    throw new Error("Local MCP bridge must declare 1-32 provider destinations");
  }
  const destinations = input.destinations.map((destination) => {
    const url = new URL(destination.origin);
    if (url.protocol !== "https:" || url.origin !== destination.origin) {
      throw new Error("Local MCP bridge destinations must be exact HTTPS origins");
    }
    if (
      !destination.pathPrefix.startsWith("/") ||
      destination.pathPrefix.includes("\\") ||
      destination.pathPrefix.includes("?") ||
      destination.pathPrefix.includes("#") ||
      new URL(destination.pathPrefix, url.origin).pathname !== destination.pathPrefix
    ) {
      throw new Error("Local MCP bridge destination pathPrefix must be an absolute URL path");
    }
    return Object.freeze({ origin: url.origin, pathPrefix: destination.pathPrefix });
  });
  return freezeDescriptor(
    { ...input, adapterId, providerId, catalogIdentity },
    "static_strict",
    destinations,
  );
}

/**
 * Describe an already-accepted immutable revision without introducing a new
 * runtime validation boundary. The revision compiler and transport retain
 * their existing URL and authority contracts; this metadata grants neither.
 */
export function describeLocalMcpBridgeDescriptor(
  input: Omit<LocalMcpBridgeDescriptor, "contractVersion" | "transport" | "assurance">,
): LocalMcpBridgeDescriptor {
  return freezeDescriptor(input, "revision_descriptive", input.destinations);
}

function freezeDescriptor(
  input: Omit<LocalMcpBridgeDescriptor, "contractVersion" | "transport" | "assurance">,
  assurance: LocalMcpBridgeDescriptor["assurance"],
  destinations: readonly LocalMcpBridgeDestination[],
): LocalMcpBridgeDescriptor {
  return Object.freeze({
    contractVersion: LOCAL_MCP_BRIDGE_CONTRACT_VERSION,
    assurance,
    adapterId: input.adapterId,
    providerId: input.providerId,
    catalogIdentity: input.catalogIdentity,
    transport: "in_process",
    authority: input.authority,
    toolSurface: input.toolSurface,
    mutationReplay: input.mutationReplay,
    destinations: Object.freeze(
      destinations.map((destination) =>
        Object.freeze({ origin: destination.origin, pathPrefix: destination.pathPrefix }),
      ),
    ),
  });
}

export function isLocalMcpBridgeServer(server: MCPServer): server is LocalMcpBridgeServer {
  const bridge = (server as Partial<LocalMcpBridgeServer>).bridge;
  return (
    bridge?.contractVersion === LOCAL_MCP_BRIDGE_CONTRACT_VERSION &&
    bridge.transport === "in_process"
  );
}

/**
 * Select exactly one adapter for a runtime catalog row. Ambiguous matches fail
 * closed so adding a bridge cannot silently replace another provider route.
 */
export function createLocalMcpBridgeFromAdapters<TConfig, TContext>(
  adapters: readonly LocalMcpBridgeAdapter<TConfig, TContext>[],
  config: TConfig,
  context: TContext,
): LocalMcpBridgeServer | null {
  const matches = adapters.filter((adapter) => adapter.matches(config));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Multiple local MCP bridge adapters matched: ${matches.map((entry) => entry.adapterId).join(", ")}`,
    );
  }
  const adapter = matches[0]!;
  const server = adapter.create(config, context);
  if (server.bridge.adapterId !== adapter.adapterId) {
    throw new Error(`Local MCP bridge adapter ${adapter.adapterId} returned mismatched metadata`);
  }
  return server;
}

function boundedIdentity(value: string, name: string, max = 128): string {
  if (value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Local MCP bridge ${name} is invalid`);
  }
  return value;
}
