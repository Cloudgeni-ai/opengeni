import type { AttemptToolDefinition } from "@opengeni/codemode";
import type { SandboxChannelAService } from "@opengeni/runtime/sandbox";
import type { SkillTextFile } from "@opengeni/runtime/skill-library";
import { checkoutSkillDirectory, readSkillDirectory } from "./skill-transfer";
import type { SkillSaveReceipt, SkillSaveRequest } from "./skill-save";

type SkillFileSystem = Pick<SandboxChannelAService, "fsList" | "fsRead" | "fsWrite" | "fsMkdir">;

export function createSkillCheckoutAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  load: (skill: string) => Promise<{
    skillId: string;
    revisionId: string | null;
    scopeVersion: number | null;
    files: readonly SkillTextFile[];
  }>;
  filesystem: () => Promise<SkillFileSystem>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "skill_checkout" },
    modelName: "skill_checkout",
    codemodePath: ["opengeni", "skill_checkout"],
    title: "Check out Skill files",
    description:
      "Copy a Skill to a fresh sandbox-relative directory for execution or larger edits. Starts the sandbox if needed. Never overwrites an existing directory and does not publish changes. Retain the returned revision and scope version for skill_publish. Use skill_read for ordinary reading without a sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", minLength: 1, maxLength: 512 },
        directory: { type: "string", minLength: 1, maxLength: 1024 },
      },
      required: ["skill", "directory"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      await input.authorize();
      const skill = await input.load(args.skill as string);
      const copied = await checkoutSkillDirectory(
        await input.filesystem(),
        args.directory as string,
        skill.files,
      );
      const output = {
        ...copied,
        skillId: skill.skillId,
        revisionId: skill.revisionId,
        scopeVersion: skill.scopeVersion,
      };
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  };
}

export function createSkillPublishAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  filesystem: () => Promise<SkillFileSystem>;
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
