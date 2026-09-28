import type { AttemptToolDefinition } from "@opengeni/codemode";
import { SKILL_READ_MAX_PATHS, type SkillTextFile } from "@opengeni/runtime/skill-library";
import { checkoutSkillDirectory, readSkillDirectory, type SkillFileSystem } from "./skill-transfer";
import type { SkillSaveReceipt, SkillSaveRequest } from "./skill-save";

export type SkillCheckoutOutcome = "written" | "unchanged" | "refused" | "failed";

/**
 * Content-free timing of one skill_checkout call. `resolve` covers authority
 * and the Skill read, `sandbox` acquiring the turn's filesystem handle, and
 * `write` the batched filesystem write. On a lazily provisioned turn whose
 * first sandbox operation is this checkout, box start is inside `write`.
 * A phase that did not run is null.
 */
export type SkillCheckoutObservation = Readonly<{
  outcome: SkillCheckoutOutcome;
  selection: "all" | "paths";
  files: number;
  written: number;
  unchanged: number;
  resolveSeconds: number | null;
  sandboxSeconds: number | null;
  writeSeconds: number | null;
  totalSeconds: number;
}>;

export function createSkillCheckoutAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  load: (skill: string) => Promise<{
    skillId: string;
    revisionId: string | null;
    scopeVersion: number | null;
    files: readonly SkillTextFile[];
  }>;
  filesystem: () => Promise<Pick<SkillFileSystem, "fsWriteFiles">>;
  /** Telemetry only; a failure here never changes the result. */
  observe?: (observation: SkillCheckoutObservation) => void;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "skill_checkout" },
    modelName: "skill_checkout",
    codemodePath: ["opengeni", "skill_checkout"],
    title: "Check out Skill files",
    description:
      "Copy Skill files into a sandbox-relative directory to run scripts or make larger edits. Starts the sandbox if needed. Writes all missing files in one step and never overwrites: files that already hold the same content are kept, and a different existing file fails the call, so repeating a checkout into the same directory is fast. Pass paths to copy only those files, for example one script to run. Only a complete copy that creates a new directory returns revisionId and scopeVersion for skill_publish. Does not publish changes. Use skill_read for reading without a sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", minLength: 1, maxLength: 512 },
        directory: { type: "string", minLength: 1, maxLength: 1024 },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: SKILL_READ_MAX_PATHS,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 1024 },
        },
      },
      required: ["skill", "directory"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      if (
        typeof args.skill !== "string" ||
        typeof args.directory !== "string" ||
        (args.paths !== undefined &&
          (!Array.isArray(args.paths) || args.paths.some((path) => typeof path !== "string")))
      ) {
        throw new Error(
          "skill_checkout requires a Skill, a directory, and optional relative paths.",
        );
      }
      const paths = args.paths as string[] | undefined;
      const started = performance.now();
      const phases: { resolve: number | null; sandbox: number | null; write: number | null } = {
        resolve: null,
        sandbox: null,
        write: null,
      };
      const timed = async <T>(phase: keyof typeof phases, run: () => Promise<T>): Promise<T> => {
        const phaseStarted = performance.now();
        try {
          return await run();
        } finally {
          phases[phase] = (performance.now() - phaseStarted) / 1_000;
        }
      };
      let copied: Awaited<ReturnType<typeof checkoutSkillDirectory>> | undefined;
      let outcome: SkillCheckoutOutcome = "refused";
      try {
        const skill = await timed("resolve", async () => {
          await input.authorize();
          return input.load(args.skill as string);
        });
        outcome = "failed";
        const filesystem = await timed("sandbox", input.filesystem);
        copied = await timed("write", () =>
          checkoutSkillDirectory(
            filesystem,
            args.directory as string,
            skill.files,
            paths ? { paths } : {},
          ),
        );
        outcome = copied.written > 0 ? "written" : "unchanged";
        // Only a complete copy into a directory this call created mirrors the
        // revision exactly, so only it may serve as a skill_publish base.
        const publishable = !paths && copied.createdDirectory;
        const output = {
          directory: copied.directory,
          fileCount: copied.fileCount,
          written: copied.written,
          unchanged: copied.unchanged,
          skillId: skill.skillId,
          ...(publishable
            ? { revisionId: skill.revisionId, scopeVersion: skill.scopeVersion }
            : { publishable: false }),
        };
        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } finally {
        try {
          input.observe?.({
            outcome,
            selection: paths ? "paths" : "all",
            files: copied?.fileCount ?? 0,
            written: copied?.written ?? 0,
            unchanged: copied?.unchanged ?? 0,
            resolveSeconds: phases.resolve,
            sandboxSeconds: phases.sandbox,
            writeSeconds: phases.write,
            totalSeconds: (performance.now() - started) / 1_000,
          });
        } catch {
          // Telemetry is best effort.
        }
      }
    },
  };
}

export function createSkillPublishAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  filesystem: () => Promise<Pick<SkillFileSystem, "fsList" | "fsRead">>;
  save: (request: SkillSaveRequest) => Promise<SkillSaveReceipt>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "skill_publish" },
    modelName: "skill_publish",
    codemodePath: ["opengeni", "skill_publish"],
    title: "Publish Skill directory",
    description:
      "Save a complete sandbox Skill directory through the same Learning-controlled service as skill_save. Reads UTF-8 text files directly; do not serialize the directory into arguments. Files missing from the directory are removed from the new revision. Supply the checkout revision and scope version; stale edits are refused. The result reports whether the change is live or pending approval.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string", format: "uuid" },
        skillId: { type: "string", format: "uuid" },
        expectedRevisionId: { type: ["string", "null"], format: "uuid" },
        expectedScopeVersion: { type: "integer", minimum: 0 },
        directory: { type: "string", minLength: 1, maxLength: 1024 },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: [
        "operationId",
        "skillId",
        "expectedRevisionId",
        "expectedScopeVersion",
        "directory",
        "reason",
      ],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      await input.authorize();
      const artifact = await readSkillDirectory(await input.filesystem(), args.directory as string);
      const output = await input.save({
        operationId: args.operationId as string,
        skillId: args.skillId as string,
        expectedRevisionId: args.expectedRevisionId as string | null,
        expectedScopeVersion: args.expectedScopeVersion as number,
        files: artifact.files,
        reason: args.reason as string,
      });
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  };
}
