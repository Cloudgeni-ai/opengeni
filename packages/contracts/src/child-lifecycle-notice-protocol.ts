import { z } from "zod";

import * as contracts from "./index";

/**
 * The exact wire protocol of the child lifecycle notices that
 * `OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED` gates.
 *
 * Release tooling reads the committed rendering
 * (`child-lifecycle-notice-protocol.gen.json`) at the live and the candidate
 * source revision. When both renderings are byte-identical, every notice a
 * candidate pod produces is one that the running fleet already produces and
 * consumes, so the candidate may boot with the flag on instead of enabling it
 * in a second rollout after the whole fleet is on the candidate. Any
 * difference, or a revision without the file, keeps the conservative
 * two-step rollout.
 *
 * The rendering covers every kind name, the gated kinds, their wake classes,
 * every exported `CHILD_*` limit, and each gated payload variant's input JSON
 * Schema including the message and source of every refinement. Bump
 * `CHILD_LIFECYCLE_NOTICE_PROTOCOL_REVISION` for any change an older consumer
 * could handle differently that this rendering cannot see (for example a field
 * whose meaning changes while its schema stays the same).
 */
export const CHILD_LIFECYCLE_NOTICE_PROTOCOL_REVISION = 1;

export const CHILD_LIFECYCLE_NOTICE_PROTOCOL_FORMAT = "opengeni.child-lifecycle-notice-protocol/v1";

/** The child lifecycle kinds produced only while the rollout flag is on. */
export const FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS = [
  "child_requires_action",
  "child_requires_action_resolved",
  "child_paused",
  "child_waiting_capacity",
  "child_progress",
] as const satisfies readonly contracts.ChildLifecycleSystemUpdateKind[];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function sortJson(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = sortJson(entry);
    }
    return sorted;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error(`child lifecycle notice protocol: cannot render ${typeof value}`);
}

type ZodInternals = {
  _zod: { def: { type: string; checks?: Array<{ _zod: { def: Record<string, unknown> } }> } };
};

function refinementMessage(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (typeof error === "function") {
    const issue = (error as (issue: unknown) => unknown)({});
    if (typeof issue === "string") return issue;
    if (
      issue &&
      typeof issue === "object" &&
      typeof (issue as { message?: unknown }).message === "string"
    ) {
      return (issue as { message: string }).message;
    }
  }
  return null;
}

/**
 * Input JSON Schema of one schema. Refinements are invisible to JSON Schema,
 * so each one is recorded with its message and source; a refinement without a
 * message string is refused, because its limit could change unseen. Value
 * rewrites (for example trim) are recorded by source, and pipes, transforms
 * and preprocessing, whose input side JSON Schema does not show, are refused.
 */
export function childLifecycleNoticeSchemaFingerprint(schema: z.ZodType): Json {
  return sortJson(
    z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "throw",
      override: (ctx) => {
        const def = (ctx.zodSchema as unknown as ZodInternals)._zod.def;
        if (def.type === "pipe" || def.type === "transform") {
          throw new Error(`child lifecycle notice protocol: a ${def.type} cannot be fingerprinted`);
        }
        const refinements: Array<{ message: string; source: string }> = [];
        const rewrites: string[] = [];
        for (const check of def.checks ?? []) {
          const checkDef = check._zod.def;
          if (checkDef.check === "overwrite") {
            rewrites.push(String(checkDef.tx));
            continue;
          }
          if (checkDef.check !== "custom") continue;
          const message = refinementMessage(checkDef.error);
          if (message === null) {
            throw new Error(
              `child lifecycle notice protocol: a ${def.type} refinement has no message string`,
            );
          }
          refinements.push({ message, source: String(checkDef.fn) });
        }
        if (refinements.length > 0) {
          (ctx.jsonSchema as Record<string, unknown>)["x-opengeni-refinements"] = refinements;
        }
        if (rewrites.length > 0) {
          (ctx.jsonSchema as Record<string, unknown>)["x-opengeni-rewrites"] = rewrites;
        }
      },
    }),
  );
}

function payloadVariant(kind: string): z.ZodType {
  const union = contracts.SessionSystemUpdatePayload as unknown as {
    _zod: { def: { options: z.ZodType[] } };
  };
  const matches = union._zod.def.options.filter((option) => {
    const shape = (option as unknown as { shape?: { type?: z.ZodType } }).shape;
    const literal = shape?.type as unknown as { _zod?: { def?: { values?: unknown[] } } };
    return literal?._zod?.def?.values?.length === 1 && literal._zod.def.values[0] === kind;
  });
  if (matches.length !== 1) {
    throw new Error(`child lifecycle notice protocol: expected one ${kind} payload variant`);
  }
  return matches[0]!;
}

/** The canonical protocol description; key order is sorted throughout. */
export function childLifecycleNoticeProtocol(): Json {
  const limits: Record<string, number | string> = {};
  for (const [name, value] of Object.entries(contracts)) {
    if (
      /^CHILD_[A-Z0-9_]+$/.test(name) &&
      (typeof value === "number" || typeof value === "string")
    ) {
      limits[name] = value;
    }
  }
  return sortJson({
    format: CHILD_LIFECYCLE_NOTICE_PROTOCOL_FORMAT,
    revision: CHILD_LIFECYCLE_NOTICE_PROTOCOL_REVISION,
    kinds: [...contracts.SessionSystemUpdateKind.options],
    childLifecycleKinds: [...contracts.CHILD_LIFECYCLE_SYSTEM_UPDATE_KINDS],
    flagGatedKinds: [...FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS],
    wakeClasses: Object.fromEntries(
      FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS.map((kind) => [
        kind,
        contracts.SESSION_SYSTEM_UPDATE_WAKE_CLASS[kind],
      ]),
    ),
    limits,
    payloads: Object.fromEntries(
      FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS.map((kind) => [
        kind,
        childLifecycleNoticeSchemaFingerprint(payloadVariant(kind)),
      ]),
    ),
  });
}

/** Exact bytes of `child-lifecycle-notice-protocol.gen.json`. */
export function renderChildLifecycleNoticeProtocol(): string {
  return `${JSON.stringify(childLifecycleNoticeProtocol(), null, 2)}\n`;
}
