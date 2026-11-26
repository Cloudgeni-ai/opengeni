import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * What a ready-made agent, app or guided setup needs before it can work, and
 * what it says about itself on the Enable page (docs/agents.md#enable). Read
 * by the Enable page, the ready-made preview and the server's readiness check.
 *
 * The rule (docs/agents.md#keep-setup-simple): an item's required steps are
 * only its own connections, and a repository where it truly needs one.
 * Another agent or setup is never required; `worksWellWith` names at most one,
 * for display only. The schema is strict so a template can't add a required
 * hand-off by another name.
 */

/** A ready-made item's template key, as in `AgentTemplate.key`. */
const ReadyMadeKey = /* @__PURE__ */ defineSchema(() =>
  z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
);

/**
 * One connection an item uses. It is found among the connections the viewer
 * can already use (the capability catalog) by its provider's domain, and by
 * `mcpUrl` when given; any one that is on and ready counts.
 */
export const SetupConnection = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The provider's domain, as on catalog items: "github.com", "slack.com", "posthog.com". */
      provider: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/u),
      /** As people say it: "GitHub", "PostHog". */
      name: z.string().trim().min(1).max(60),
      /** The MCP address of the catalog connector to offer for Connect, when it is one. */
      mcpUrl: z.string().url().max(2048).optional(),
      /** Off without it. Optional connections add to what it can do. */
      required: z.boolean(),
      /** One short line: what it uses the connection for. */
      why: z.string().trim().min(1).max(160),
    })
    .strict(),
);
export type SetupConnection = z.output<typeof SetupConnection>;

/** The optional, display-and-readiness facts of a ready-made item. */
export const ReadyMadeSetup = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      connections: z.array(SetupConnection).max(8).default([]),
      /**
       * Whether its triggers need a repository: "required" when its work is
       * always on one codebase. Null: it doesn't ask for one.
       */
      repository: z.enum(["required", "optional"]).nullable().default(null),
      /** One other ready-made agent that complements it. Display only; never a step. */
      worksWellWith: ReadyMadeKey.nullable().default(null),
      /** Short lines: what it asks a person before doing (backed by its Can use rules). */
      wontDoWithoutAsking: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
      /**
       * Right after it is turned on, it starts a chat with this message so the
       * person sees it work without writing a prompt. Null: it doesn't.
       */
      firstMessage: z.string().trim().min(1).max(2000).nullable().default(null),
      /** One small first job to suggest at the end of Enable. */
      firstJob: z.string().trim().min(1).max(200).nullable().default(null),
    })
    .strict(),
);
export type ReadyMadeSetup = z.output<typeof ReadyMadeSetup>;
export type ReadyMadeSetupInput = z.input<typeof ReadyMadeSetup>;

/** What the readiness check knows about one connection, for the viewer. */
export const SetupConnectionState = /* @__PURE__ */ defineSchema(() =>
  z.object({
    provider: z.string(),
    name: z.string(),
    mcpUrl: z.string().nullable().default(null),
    required: z.boolean(),
    why: z.string(),
    /** On and ready among the connections the viewer can use. */
    connected: z.boolean(),
    /** Whether the viewer may connect it here (the Connect pages' own rule). */
    canConnect: z.boolean(),
    /** The catalog item to open for Connect; null when this deployment doesn't offer one. */
    catalogItemId: z.string().nullable().default(null),
  }),
);
export type SetupConnectionState = z.output<typeof SetupConnectionState>;

/** One thing that keeps an item off, with the reason in words. */
export const SetupMissing = /* @__PURE__ */ defineSchema(() =>
  z.object({
    kind: z.literal("connection"),
    provider: z.string(),
    name: z.string(),
    /** "Connect GitHub to turn this on." or "Ask an admin to connect GitHub." */
    reason: z.string(),
  }),
);
export type SetupMissing = z.output<typeof SetupMissing>;

/**
 * The server's readiness check: ready when every required connection is on.
 * Triggers of a ready-made agent can't be turned on until it is.
 */
export const SetupReadiness = /* @__PURE__ */ defineSchema(() =>
  z.object({
    ready: z.boolean(),
    /** The first missing item's reason; null when ready. */
    reason: z.string().nullable(),
    connections: z.array(SetupConnectionState),
    missing: z.array(SetupMissing),
    /** "N of M required connected", as numbers. */
    requiredConnected: z.number().int().nonnegative(),
    requiredTotal: z.number().int().nonnegative(),
  }),
);
export type SetupReadiness = z.output<typeof SetupReadiness>;

export const SetupReadinessResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ readiness: SetupReadiness }),
);
export type SetupReadinessResponse = z.output<typeof SetupReadinessResponse>;

/** The facts the readiness check reads about one connection; the server derives them from the catalog. */
export type SetupConnectionFacts = {
  connected: boolean;
  canConnect: boolean;
  catalogItemId: string | null;
};

/** The reason a connection keeps an item off, in words. */
export function setupMissingReason(
  connection: Pick<SetupConnection, "name">,
  canConnect: boolean,
): string {
  return canConnect
    ? `Connect ${connection.name} to turn this on.`
    : `Ask an admin to connect ${connection.name}.`;
}

/**
 * The readiness of an item from its connections and what is known about each.
 * Pure: the server passes catalog facts; tests and previews pass fixtures.
 */
export function evaluateSetupReadiness(
  setup: Pick<ReadyMadeSetup, "connections"> | null | undefined,
  factsFor: (connection: SetupConnection) => SetupConnectionFacts,
): SetupReadiness {
  const connections = (setup?.connections ?? []).map((connection) => {
    const facts = factsFor(connection);
    return SetupConnectionState.parse({
      provider: connection.provider,
      name: connection.name,
      mcpUrl: connection.mcpUrl ?? null,
      required: connection.required,
      why: connection.why,
      connected: facts.connected,
      canConnect: facts.canConnect,
      catalogItemId: facts.catalogItemId,
    });
  });
  const missing = connections
    .filter((connection) => connection.required && !connection.connected)
    .map((connection) =>
      SetupMissing.parse({
        kind: "connection",
        provider: connection.provider,
        name: connection.name,
        reason: setupMissingReason(connection, connection.canConnect),
      }),
    );
  const required = connections.filter((connection) => connection.required);
  return {
    ready: missing.length === 0,
    reason: missing[0]?.reason ?? null,
    connections,
    missing,
    requiredConnected: required.filter((connection) => connection.connected).length,
    requiredTotal: required.length,
  };
}
