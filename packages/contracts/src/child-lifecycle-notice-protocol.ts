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
 * the classifications, the paused-notice classification rule, every exported
 * `CHILD_*` limit, and each gated payload variant's input JSON Schema plus
 * the full definition of every check on every node (limits, patterns with
 * flags, formats, URL restrictions). A refinement is accepted only from a
 * helper that records its limit as data (`UTF8_BYTE_LIMIT_CHECKS`) and is
 * recorded with that limit, its message and its source. Any other
 * refinement, a conditional (`when`) refinement, a pipe, transform or
 * preprocessing step is refused, so the rendering never calls two different
 * schemas identical. `CHILD_LIFECYCLE_NOTICE_PROTOCOL_REVISION` covers what a
 * schema cannot express.
 */
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

type ZodCheckInternals = { _zod: { def: Record<string, unknown> } };
type ZodInternals = { _zod: { def: Record<string, unknown> & { type: string } } };

function isZodNode(value: unknown): boolean {
  return value !== null && typeof value === "object" && "_zod" in value;
}

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
 * The data of one definition. Nested schemas are rendered by their own JSON
 * Schema node, so only their position is kept; library functions (zod's own
 * `when` guards and error factories) are internals of the locked zod version
 * and are omitted; patterns keep their flags.
 */
function definitionData(value: unknown): unknown {
  if (isZodNode(value)) return "<schema>";
  if (value instanceof RegExp) return { regex: value.source, flags: value.flags };
  if (typeof value === "function") return undefined;
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.map(definitionData);
  if (value !== null && typeof value === "object") {
    const data: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) data[key] = definitionData(entry);
    return data;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function checkData(check: ZodCheckInternals, owner: string): unknown {
  const def = check._zod.def;
  if (def.check === "custom") {
    const maxBytes = contracts.UTF8_BYTE_LIMIT_CHECKS.get(check);
    if (maxBytes === undefined) {
      throw new Error(
        `child lifecycle notice protocol: a ${owner} refinement does not record its limit as data`,
      );
    }
    if (def.when !== undefined) {
      throw new Error(`child lifecycle notice protocol: a ${owner} refinement is conditional`);
    }
    const message = refinementMessage(def.error);
    if (message === null) {
      throw new Error(`child lifecycle notice protocol: a ${owner} refinement has no message`);
    }
    return { check: "custom", utf8MaxBytes: maxBytes, message, source: String(def.fn) };
  }
  if (def.check === "overwrite") return { check: "overwrite", source: String(def.tx) };
  const data = definitionData(def) as Record<string, unknown>;
  const message = refinementMessage(def.error);
  if (message !== null) data.message = message;
  return data;
}

/**
 * Input JSON Schema of one schema, with every node's own definition data and
 * checks recorded beside it (`x-opengeni-def`), because JSON Schema drops
 * refinements, regex flags and URL restrictions.
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
        const { checks, ...rest } = def;
        const recorded = definitionData(rest) as Record<string, unknown>;
        recorded.checks = ((checks as ZodCheckInternals[] | undefined) ?? []).map((check) =>
          checkData(check, def.type),
        );
        (ctx.jsonSchema as Record<string, unknown>)["x-opengeni-def"] = recorded;
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
      name !== "CHILD_LIFECYCLE_NOTICE_PROTOCOL_REVISION" &&
      (typeof value === "number" || typeof value === "string")
    ) {
      limits[name] = value;
    }
  }
  return sortJson({
    format: CHILD_LIFECYCLE_NOTICE_PROTOCOL_FORMAT,
    revision: contracts.CHILD_LIFECYCLE_NOTICE_PROTOCOL_REVISION,
    kinds: [...contracts.SessionSystemUpdateKind.options],
    classifications: [...contracts.SystemUpdateClassification.options],
    childLifecycleKinds: [...contracts.CHILD_LIFECYCLE_SYSTEM_UPDATE_KINDS],
    flagGatedKinds: [...FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS],
    wakeClasses: Object.fromEntries(
      FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS.map((kind) => [
        kind,
        contracts.SESSION_SYSTEM_UPDATE_WAKE_CLASS[kind],
      ]),
    ),
    pausedClassification: Object.fromEntries(
      (["human", "api", "agent"] as const).map((actor) => [
        actor,
        contracts.childPausedClassification(actor),
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
