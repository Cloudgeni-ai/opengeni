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

/** One line of what it won't do without asking, and the tools whose rule enforces it. */
export const SetupGuardrail = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Short, plain words: "Merge a pull request". */
      text: z.string().trim().min(1).max(120),
      /** `block`: it never does this. `ask`: it asks a person first. */
      permission: z.enum(["ask", "block"]),
      /** The connection the tools belong to, as its Can use rules name it (`github.com`). */
      connector: z.string().trim().min(1).max(512),
      /** The tool names its rules cover; each has a rule with this permission. */
      tools: z.array(z.string().trim().min(1).max(256)).min(1).max(8),
    })
    .strict(),
);
export type SetupGuardrail = z.output<typeof SetupGuardrail>;

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
      /**
       * What it won't do, or asks first about, each line backed by one of its
       * own Can use rules (`toolPermissions`) for the tools it names: `block`
       * never does it, `ask` asks a person in a chat and, in a run on its
       * own, stops instead.
       */
      wontDoWithoutAsking: z.array(SetupGuardrail).max(5).default([]),
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
    /**
     * How the viewer connects GitHub here: the workspace's GitHub App, or
     * their own GitHub. Null for anything else, or when they can't.
     */
    connectVia: z.enum(["github_app", "github_personal"]).nullable().default(null),
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

/** `GET /agents/readiness`: each visible agent's readiness, read in one pass. */
export const AgentReadinessListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    agents: z.array(z.object({ agentId: z.string(), readiness: SetupReadiness })),
  }),
);
export type AgentReadinessListResponse = z.output<typeof AgentReadinessListResponse>;

/**
 * `POST /setup-connection-requests` ("Ask an admin" on the Enable page): the
 * caller can't connect `provider` and asks the workspace's admins in their
 * inbox. `returnPath` is the Enable step the admins open.
 */
export const SetupConnectionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      provider: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,99}$/u),
      name: z.string().trim().min(1).max(80),
      returnPath: z.string().min(1).max(1024),
    })
    .strict(),
);
export type SetupConnectionRequest = z.output<typeof SetupConnectionRequest>;

/**
 * `requested`: the admins were asked (asking again never asks twice).
 * `unavailable`: no admin could be asked here yet; the page shares a link instead.
 */
export const SetupConnectionRequestResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    status: z.enum(["requested", "unavailable"]),
    adminsAsked: z.number().int().min(0),
  }),
);
export type SetupConnectionRequestResponse = z.output<typeof SetupConnectionRequestResponse>;

/** The facts the readiness check reads about one connection; the server derives them from the catalog. */
export type SetupConnectionFacts = {
  connected: boolean;
  canConnect: boolean;
  catalogItemId: string | null;
  connectVia?: "github_app" | "github_personal" | null;
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
      connectVia: facts.connectVia ?? null,
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

/** One guardrail line in words, as it really behaves: "Merge a pull request: never". */
export function setupGuardrailWords(line: Pick<SetupGuardrail, "text" | "permission">): string {
  return `${line.text}: ${line.permission === "block" ? "never" : "asks first"}`;
}

/** Said once under the lines when any asks first: an unattended run has no one to ask. */
export const SETUP_GUARDRAIL_UNATTENDED_NOTE =
  "When it runs on its own, it stops instead of asking.";
