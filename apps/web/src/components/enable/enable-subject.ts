/**
 * Enable (docs/agents.md#enable): one guided page that turns on a ready-made
 * agent, a ready-made app or a Get started setup. Three steps: Connect,
 * Check, Turn on. This file is the page's pure logic; enable-page.tsx draws it.
 *
 * What an item needs comes from its template's `setup` and the server's
 * readiness check (`GET .../agent-templates/:key/readiness`), so the page,
 * the Agents page and the server agree on when it can be turned on.
 */
import { setupMissingReason } from "@opengeni/contracts";
import type { SetupConnectionState, SetupMissing, SetupReadiness } from "@opengeni/sdk";

export type EnableStep = "connect" | "check" | "turn-on";
export const ENABLE_STEPS: readonly { key: EnableStep; label: string }[] = [
  { key: "connect", label: "Connect" },
  { key: "check", label: "Check" },
  { key: "turn-on", label: "Turn on" },
];

export function enableStepOf(value: unknown): EnableStep | undefined {
  return value === "connect" || value === "check" || value === "turn-on" ? value : undefined;
}

/** What Enable turns on. A setup is an agent with its own trigger and stricter needs. */
export type EnableSubject =
  | {
      kind: "agent";
      /** The ready-made agent's template key. */
      templateKey: string;
      /** The suggested trigger it turns on; the template's first one-click trigger when absent. */
      triggerName?: string | undefined;
      /** Providers this setup needs although the agent alone doesn't (Linear for issue triage). */
      requireProviders?: readonly string[] | undefined;
    }
  | { kind: "app"; templateKey: string };

export type EnableSearch = { agent?: string; app?: string; step?: EnableStep };

const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** The Enable route's search: one subject and the step to open on. */
export function parseEnableSearch(search: Record<string, unknown>): EnableSearch {
  const step = enableStepOf(search.step);
  const agent = typeof search.agent === "string" && KEY.test(search.agent) ? search.agent : null;
  const app = typeof search.app === "string" && KEY.test(search.app) ? search.app : null;
  return {
    ...(agent ? { agent } : app ? { app } : {}),
    ...(step ? { step } : {}),
  };
}

export function enableSubjectOf(search: EnableSearch): EnableSubject | null {
  if (search.agent) return { kind: "agent", templateKey: search.agent };
  if (search.app) return { kind: "app", templateKey: search.app };
  return null;
}

/** Where Enable opens for a ready-made agent or app, on a step. */
export function enableHref(
  workspaceId: string,
  subject: Pick<EnableSubject, "kind" | "templateKey">,
  step?: EnableStep,
): string {
  const params = new URLSearchParams({ [subject.kind]: subject.templateKey });
  if (step) params.set("step", step);
  return `/workspaces/${encodeURIComponent(workspaceId)}/enable?${params.toString()}`;
}

function missingFor(connection: SetupConnectionState): SetupMissing {
  return {
    kind: "connection",
    provider: connection.provider,
    name: connection.name,
    reason: setupMissingReason(connection, connection.canConnect),
  };
}

/**
 * The readiness with more providers required, for a setup that needs a
 * connection the agent alone treats as optional. Same counting as the server.
 */
export function withRequiredProviders(
  readiness: SetupReadiness,
  providers: readonly string[] | undefined,
): SetupReadiness {
  if (!providers || providers.length === 0) return readiness;
  const connections = readiness.connections.map((connection) =>
    providers.includes(connection.provider) ? { ...connection, required: true } : connection,
  );
  const required = connections.filter((connection) => connection.required);
  const missing = required.filter((connection) => !connection.connected).map(missingFor);
  return {
    ready: missing.length === 0,
    reason: missing[0]?.reason ?? null,
    connections,
    missing,
    requiredConnected: required.length - missing.length,
    requiredTotal: required.length,
  };
}

/** Required connections first, then optional; each keeps its template order. */
export function orderedConnections(readiness: SetupReadiness): SetupConnectionState[] {
  return [
    ...readiness.connections.filter((connection) => connection.required),
    ...readiness.connections.filter((connection) => !connection.required),
  ];
}

/** "1 of 2 required connected", or null when nothing is required. */
export function requiredSummary(readiness: SetupReadiness): string | null {
  return readiness.requiredTotal === 0
    ? null
    : `${readiness.requiredConnected} of ${readiness.requiredTotal} required connected`;
}

/** What the Connect control of one connection is. */
export type ConnectControl = "connected" | "connect" | "ask-admin" | "not-offered";

export function connectControlOf(
  connection: Pick<SetupConnectionState, "connected" | "canConnect" | "catalogItemId" | "provider">,
): ConnectControl {
  if (connection.connected) return "connected";
  if (!connection.canConnect) return "ask-admin";
  // GitHub connects through its own app flow; others through their catalog page.
  if (connection.provider !== "github.com" && !connection.catalogItemId) return "not-offered";
  return "connect";
}

/** Where the page is: connecting, ready to turn on, or on. */
export type EnableStage = "connect" | "turn-on" | "on";

export function enableStage({
  readiness,
  on,
}: {
  /** Null when it couldn't be read: the server still checks on Turn on. */
  readiness: SetupReadiness | null;
  on: boolean;
}): EnableStage {
  if (on) return "on";
  return readiness && !readiness.ready ? "connect" : "turn-on";
}

/**
 * Why Turn on is disabled, in words; null when it can be pressed. The first
 * that applies: something to connect, then permission, then the trigger.
 */
export function turnOnBlocker({
  readiness,
  canAdd,
  canEdit,
  added,
  triggerFound,
  subjectName,
}: {
  readiness: SetupReadiness | null;
  /** May add it (agents: sessions:create; apps: artifacts:publish). */
  canAdd: boolean;
  /** May change the added agent's triggers; true for apps and before it is added. */
  canEdit: boolean;
  added: boolean;
  /** The trigger to turn on exists in its template; true for apps. */
  triggerFound: boolean;
  subjectName: string;
}): string | null {
  if (readiness && !readiness.ready) return readiness.reason;
  if (!added && !canAdd) return `Ask an admin to add ${subjectName}.`;
  if (added && !canEdit) return `Needs edit access to ${subjectName}.`;
  if (!triggerFound) return `${subjectName} has nothing to turn on.`;
  return null;
}

/** A readiness for an item that declares no connections. */
export const NOTHING_TO_CONNECT: SetupReadiness = {
  ready: true,
  reason: null,
  connections: [],
  missing: [],
  requiredConnected: 0,
  requiredTotal: 0,
};
