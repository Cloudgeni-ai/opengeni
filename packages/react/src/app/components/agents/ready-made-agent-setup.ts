/**
 * What a ready-made agent's preview says about it: what it does and won't do
 * without asking, what it needs (Required or Optional), at most one agent it
 * works well with, and its cost per run. Read from the template's setup
 * fields; an older server without them gets what its suggested triggers
 * imply. Pure.
 */
import type { AgentTemplate } from "@opengeni/contracts";

export interface ReadyMadeNeed {
  key: string;
  label: string;
  required: boolean;
  /** One quiet line: "Chosen after adding". */
  detail?: string | null | undefined;
}

export interface ReadyMadeSetup {
  does: string[];
  wontDoWithoutAsking: string[];
  needs: ReadyMadeNeed[];
  /** The name of at most one agent it works well with; never required. */
  worksWellWith: string | null;
  /** "About $0.40 a run", when known. */
  costPerRun: string | null;
}

type SetupFields = {
  requiredConnections?: readonly { key?: string; name?: string; label?: string }[];
  optionalConnections?: readonly { key?: string; name?: string; label?: string }[];
  repository?: unknown;
  worksWellWith?: unknown;
  wontDoWithoutAsking?: readonly string[];
  does?: readonly string[];
  costPerRunMicros?: number | null;
};

const KIND_NAMES: Record<string, string> = {
  github: "GitHub",
  slack: "Slack",
  webhook: "A webhook",
  workspace: "This workspace",
};

function connectionNeed(
  entry: { key?: string; name?: string; label?: string },
  required: boolean,
): ReadyMadeNeed {
  const key = entry.key ?? entry.name ?? entry.label ?? "connection";
  return { key, label: entry.label ?? entry.name ?? KIND_NAMES[key] ?? key, required };
}

function worksWellWithName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return worksWellWithName(value[0]);
  if (value && typeof value === "object") {
    const named = value as { name?: unknown; label?: unknown };
    if (typeof named.name === "string") return named.name;
    if (typeof named.label === "string") return named.label;
  }
  return null;
}

function money(micros: number): string {
  const value = micros / 1_000_000;
  return `About $${value >= 0.01 ? value.toFixed(2) : value.toFixed(3)} a run`;
}

export function readyMadeAgentSetup(template: AgentTemplate): ReadyMadeSetup {
  const fields = template as AgentTemplate & SetupFields;
  const needs: ReadyMadeNeed[] = [];
  if (fields.requiredConnections || fields.optionalConnections) {
    for (const entry of fields.requiredConnections ?? []) needs.push(connectionNeed(entry, true));
    for (const entry of fields.optionalConnections ?? []) needs.push(connectionNeed(entry, false));
  } else {
    // An older server: each kind its suggested triggers listen on, optional.
    const kinds = new Set(
      template.suggestedTriggers.flatMap((suggestion) =>
        suggestion.triggers.map((trigger) => trigger.source.kind as string),
      ),
    );
    for (const kind of kinds) {
      if (kind !== "workspace")
        needs.push({ key: kind, label: KIND_NAMES[kind] ?? kind, required: false });
    }
  }
  const repository = fields.repository;
  if (repository && repository !== "none") {
    const required =
      repository === true ||
      repository === "required" ||
      (typeof repository === "object" && (repository as { required?: unknown }).required === true);
    needs.push({
      key: "repository",
      label: "A repository",
      required,
      detail: "Chosen after adding",
    });
  }
  return {
    does: fields.does?.length
      ? [...fields.does]
      : template.description
        ? [template.description]
        : [],
    wontDoWithoutAsking: [...(fields.wontDoWithoutAsking ?? [])],
    needs,
    worksWellWith: worksWellWithName(fields.worksWellWith),
    costPerRun:
      typeof fields.costPerRunMicros === "number" && fields.costPerRunMicros > 0
        ? money(fields.costPerRunMicros)
        : null,
  };
}
