import type { AttemptToolDefinition } from "@opengeni/codemode";
import type { AttemptToolResult } from "@opengeni/contracts";
import {
  listSkillPaths,
  PORTABLE_SKILL_MAX_FILES,
  readSkillFiles,
  SKILL_READ_MAX_PATHS,
  type SkillTextFile,
} from "@opengeni/runtime/skill-library";

export const SKILL_READ_TOOL_NAME = "skill_read";

export type SkillReadContent = Readonly<{
  files: readonly SkillTextFile[];
  skillId: string;
  revisionId: string;
  scopeVersion: number;
  installationVersion?: number;
}>;

type SkillReadIdentity = Partial<Omit<SkillReadContent, "files">>;

const IDENTITY_KEYS = ["skillId", "revisionId", "scopeVersion", "installationVersion"] as const;

/** A first-party gateway definition, not a sandbox capability or second backend. */
export function createSkillReadAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  load: (skill: string) => Promise<readonly SkillTextFile[] | SkillReadContent>;
  /**
   * Earlier skill_read results still in this session's active model history.
   * Without it every read returns full text.
   */
  activeReadResults?: () => Promise<ReadonlyArray<Record<string, unknown>>>;
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
      const loaded = await input.load(args.skill);
      const metadata = "files" in loaded ? loaded : null;
      const files = metadata ? metadata.files : (loaded as readonly SkillTextFile[]);
      const identity: SkillReadIdentity = metadata
        ? {
            skillId: metadata.skillId,
            revisionId: metadata.revisionId,
            scopeVersion: metadata.scopeVersion,
            ...(metadata.installationVersion !== undefined
              ? { installationVersion: metadata.installationVersion }
              : {}),
          }
        : {};
      if (args.listFiles === true) {
        return textResult({ ...identity, ...listSkillPaths(files, PORTABLE_SKILL_MAX_FILES) });
      }
      const selected = readSkillFiles(files, args.paths as string[] | undefined);
      // Only the model's default SKILL.md read is deduplicated: explicit paths
      // are the fresh-copy request, and a Codemode program never sees history.
      if (
        args.paths === undefined &&
        context.caller.kind === "model" &&
        input.activeReadResults &&
        (await input.activeReadResults()).some((item) =>
          returnedFile(item, identity, selected.files[0]!),
        )
      ) {
        return textResult({
          ...identity,
          alreadyInContext: true,
          message: `Already in context: SKILL.md of ${JSON.stringify(args.skill)}${identity.revisionId ? ` revision ${identity.revisionId}` : ""} was returned earlier in this conversation and is unchanged. Use that copy. Re-read only if you need a fresh copy: call skill_read with paths ["SKILL.md"].`,
        });
      }
      return textResult({ ...identity, ...selected });
    },
  };
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
