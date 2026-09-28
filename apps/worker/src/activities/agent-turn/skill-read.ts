import { boundModelToolOutputItem } from "@opengeni/codex";
import type { AttemptToolDefinition, AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  SKILL_USE_META_KEY,
  SkillUse,
  type AttemptToolResult,
  type SkillReadKind,
  type SkillUseSource,
} from "@opengeni/contracts";
import { modelToolResultFits } from "@opengeni/runtime";
import {
  listSkillPaths,
  PORTABLE_SKILL_MAX_FILES,
  readSkillFiles,
  SKILL_READ_MAX_PATHS,
  type SkillTextFile,
} from "@opengeni/runtime/skill-library";

export const SKILL_READ_TOOL_NAME = "skill_read";

type JsonValue = NonNullable<AttemptToolResult["_meta"]>[string];

/** Content-free provenance of a resolved Skill. The caller never receives it. */
export type SkillReadOrigin = Readonly<{
  id: string;
  source: SkillUseSource;
  /** Platform display label of a built-in; never user-authored text. */
  label?: string;
  /** Whole-artifact digest, for an artifact without a ledger revision. */
  contentSha256?: string;
}>;

export type SkillReadContent = Readonly<{
  files: readonly SkillTextFile[];
  skillId: string;
  revisionId: string;
  scopeVersion: number;
  installationVersion?: number;
  origin?: SkillReadOrigin;
}>;

/** A selected built-in or session artifact: no ledger identity, and none is synthesized. */
export type SelectedSkillReadContent = Readonly<{
  files: readonly SkillTextFile[];
  origin: SkillReadOrigin;
}>;

type SkillReadIdentity = Partial<
  Pick<SkillReadContent, "skillId" | "revisionId" | "scopeVersion" | "installationVersion">
>;

export type SkillReadObservation = Readonly<{
  caller: AttemptToolExecutionContext["caller"]["kind"];
  kind: SkillReadKind;
  /** Null when the read was refused before a Skill resolved. */
  source: SkillUseSource | null;
  /** The resolved Skill id, or the requested identifier when none resolved. */
  skill: string;
}>;

/**
 * Content-free read telemetry. It never changes what the caller receives: a
 * model result gains only MCP `_meta`, which the model never sees and which
 * only the tool-output event projection keeps.
 */
export type SkillReadTelemetry = Readonly<{
  /** Ids in the Skill index the model sees this turn; null until known. */
  indexedSkillIds: () => ReadonlySet<string> | null;
  /** Whether skill_search returned this id earlier in this turn attempt. */
  searched: (id: string) => boolean;
  observe: (observation: SkillReadObservation) => void;
}>;

export type SkillReadActiveHistory = Readonly<{
  /** Earlier skill_read results still in this session's active model history. */
  readResults: () => Promise<ReadonlyArray<Record<string, unknown>>>;
  /**
   * This turn's model tool-output bound. Rows are bounded when stored, but a
   * later model with a lower bound receives a shorter copy than the row holds.
   */
  toolOutputTruncationTokens: () => number;
  /** The lookup only saves tokens, so a failure returns the full text. */
  onLookupFailed?: (error: unknown) => void;
}>;

const IDENTITY_KEYS = ["skillId", "revisionId", "scopeVersion", "installationVersion"] as const;

/** A first-party gateway definition, not a sandbox capability or second backend. */
export function createSkillReadAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  load: (
    skill: string,
  ) => Promise<readonly SkillTextFile[] | SkillReadContent | SelectedSkillReadContent>;
  /** Without it every read returns full text. */
  activeHistory?: SkillReadActiveHistory;
  telemetry?: SkillReadTelemetry;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: SKILL_READ_TOOL_NAME },
    modelName: SKILL_READ_TOOL_NAME,
    codemodePath: ["opengeni", SKILL_READ_TOOL_NAME],
    title: "Read Skill files",
    description:
      "Read Skill text without starting a sandbox. Omit paths to read SKILL.md; provide relative paths to read exactly those files, never implicitly adding SKILL.md. Set listFiles:true without paths to list relative paths and available revision identity only, with no file bodies. Use an id or name from the Skill index or skill_search. Management tools are lazy; when listed, opengeni-skills explains how to use them.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", minLength: 1, maxLength: 512 },
        listFiles: { type: "boolean" },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: SKILL_READ_MAX_PATHS,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 1024 },
        },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    annotations: {
      title: "Read Skill files",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args, context) => {
      if (
        typeof args.skill !== "string" ||
        !args.skill ||
        (args.listFiles !== undefined && typeof args.listFiles !== "boolean") ||
        (args.paths !== undefined &&
          (!Array.isArray(args.paths) || args.paths.some((path) => typeof path !== "string")))
      ) {
        throw new Error("skill_read requires a Skill identifier and optional relative paths.");
      }
      if (args.listFiles === true && args.paths !== undefined) {
        throw new Error("skill_read listFiles:true cannot be combined with paths.");
      }
      await input.authorize();
      const skill = args.skill;
      let origin: SkillReadOrigin | undefined;
      let identity: SkillReadIdentity = {};
      let read: { kind: Exclude<SkillReadKind, "refused">; result: AttemptToolResult };
      try {
        const loaded = await input.load(skill);
        const content = "files" in loaded ? loaded : { files: loaded };
        origin = "origin" in content ? content.origin : undefined;
        if ("skillId" in content) {
          identity = {
            skillId: content.skillId,
            revisionId: content.revisionId,
            scopeVersion: content.scopeVersion,
            ...(content.installationVersion !== undefined
              ? { installationVersion: content.installationVersion }
              : {}),
          };
        }
        read = await readResult(
          content.files,
          identity,
          args as { skill: string; listFiles?: boolean; paths?: string[] },
          context,
          input.activeHistory,
        );
      } catch (error) {
        observe(input.telemetry, { caller: context.caller.kind, kind: "refused", origin, skill });
        throw error;
      }
      observe(input.telemetry, { caller: context.caller.kind, kind: read.kind, origin, skill });
      return context.caller.kind === "model" && origin && input.telemetry
        ? withSkillUse(read, origin, identity, input.telemetry)
        : read.result;
    },
  };
}

async function readResult(
  files: readonly SkillTextFile[],
  identity: SkillReadIdentity,
  args: { skill: string; listFiles?: boolean; paths?: string[] },
  context: AttemptToolExecutionContext,
  activeHistory: SkillReadActiveHistory | undefined,
): Promise<{ kind: Exclude<SkillReadKind, "refused">; result: AttemptToolResult }> {
  if (args.listFiles === true) {
    return {
      kind: "list",
      result: textResult({ ...identity, ...listSkillPaths(files, PORTABLE_SKILL_MAX_FILES) }),
    };
  }
  const selected = readSkillFiles(files, args.paths);
  // Only the model's default SKILL.md read is deduplicated: explicit paths
  // are the fresh-copy request, and a Codemode program never sees history.
  if (
    args.paths === undefined &&
    context.caller.kind === "model" &&
    activeHistory &&
    (await inActiveHistory(activeHistory, identity, selected.files[0]!))
  ) {
    return {
      kind: "already_in_context",
      result: textResult({
        ...identity,
        alreadyInContext: true,
        message: `Already in context: SKILL.md of ${JSON.stringify(args.skill)}${identity.revisionId ? ` revision ${identity.revisionId}` : ""} was returned earlier in this conversation and is unchanged. Use that copy. Re-read only if you need a fresh copy: call skill_read with paths ["SKILL.md"].`,
      }),
    };
  }
  return {
    kind: args.paths === undefined ? "full" : "files",
    result: textResult({ ...identity, ...selected }),
  };
}

/** Telemetry must never change or fail a read. */
function observe(
  telemetry: SkillReadTelemetry | undefined,
  read: {
    caller: SkillReadObservation["caller"];
    kind: SkillReadKind;
    origin: SkillReadOrigin | undefined;
    skill: string;
  },
): void {
  if (!telemetry) return;
  try {
    telemetry.observe({
      caller: read.caller,
      kind: read.kind,
      source: read.origin?.source ?? null,
      skill: read.origin?.id ?? read.skill,
    });
  } catch {
    // Metrics are best effort.
  }
}

/**
 * Adds the content-free Skill-use fact as MCP `_meta`. The model output is
 * the text part alone, so it stays byte-identical. The fact is dropped
 * rather than let it push a result past the model-visible size cap, which
 * would change what the model receives.
 */
function withSkillUse(
  read: { kind: Exclude<SkillReadKind, "refused">; result: AttemptToolResult },
  origin: SkillReadOrigin,
  identity: SkillReadIdentity,
  telemetry: SkillReadTelemetry,
): AttemptToolResult {
  try {
    const text = read.result.content[0]?.type === "text" ? read.result.content[0].text : "";
    // Parsing rejects anything outside the closed, content-free shape.
    const use = SkillUse.parse({
      id: origin.id,
      source: origin.source,
      ...(origin.label ? { label: origin.label } : {}),
      ...(identity.revisionId
        ? { revisionId: identity.revisionId }
        : origin.contentSha256
          ? { contentSha256: origin.contentSha256 }
          : {}),
      kind: read.kind,
      bytes: Buffer.byteLength(text, "utf8"),
      inIndex: telemetry.indexedSkillIds()?.has(origin.id) ?? false,
      searchedThisTurn: telemetry.searched(origin.id),
    });
    const annotated: AttemptToolResult = {
      ...read.result,
      _meta: { ...read.result._meta, [SKILL_USE_META_KEY]: use as JsonValue },
    };
    return modelToolResultFits(annotated) ? annotated : read.result;
  } catch {
    return read.result;
  }
}

function textResult(
  output: NonNullable<AttemptToolResult["structuredContent"]>,
): AttemptToolResult {
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

async function inActiveHistory(
  history: SkillReadActiveHistory,
  identity: SkillReadIdentity,
  file: SkillTextFile,
): Promise<boolean> {
  let results: ReadonlyArray<Record<string, unknown>>;
  try {
    results = await history.readResults();
  } catch (error) {
    history.onLookupFailed?.(error);
    return false;
  }
  const tokens = history.toolOutputTruncationTokens();
  // Judge the copy this turn's model receives, not the stored row.
  return results.some((item) =>
    returnedFile(boundModelToolOutputItem(item, tokens), identity, file),
  );
}

/**
 * True when an earlier result gave the model this exact file text under the
 * same Skill identity. A truncated, spilled, or failed result does not parse
 * as a Skill read, so it never counts.
 */
function returnedFile(
  item: Record<string, unknown>,
  identity: SkillReadIdentity,
  file: SkillTextFile,
): boolean {
  const text = resultText(item.output);
  if (text === null) return false;
  let previous: unknown;
  try {
    previous = JSON.parse(text);
  } catch {
    return false;
  }
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return false;
  const record = previous as Record<string, unknown>;
  return (
    IDENTITY_KEYS.every((key) => record[key] === identity[key]) &&
    Array.isArray(record.files) &&
    record.files.some(
      (candidate: unknown) =>
        !!candidate &&
        typeof candidate === "object" &&
        (candidate as SkillTextFile).path === file.path &&
        (candidate as SkillTextFile).content === file.content,
    )
  );
}

/** The single text part of a function result, in any SDK output shape. */
function resultText(output: unknown): string | null {
  if (typeof output === "string") return output;
  const parts = Array.isArray(output) ? output : [output];
  if (parts.length !== 1) return null;
  const part = parts[0] as { type?: unknown; text?: unknown } | null;
  return part &&
    typeof part === "object" &&
    (part.type === "text" || part.type === "input_text") &&
    typeof part.text === "string"
    ? part.text
    : null;
}
