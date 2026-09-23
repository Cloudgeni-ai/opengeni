import type { AttemptToolDefinition } from "@opengeni/codemode";
import type { SkillSaveReceipt } from "./skill-save";

/** The installer resolves/pins bytes and persists them through the shared lifecycle. */
export function createSkillInstallAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  install: (request: {
    operationId: string;
    source: string;
    expectedInstallationVersion?: number;
    reason: string;
  }) => Promise<SkillSaveReceipt>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "skill_install" },
    modelName: "skill_install",
    codemodePath: ["opengeni", "skill_install"],
    title: "Install a Skill",
    description:
      "Install a Skill from a public skills.sh or GitHub URL, or library:<id> returned by skill_search. The server resolves and pins the source; no prior preview or invented hash is required. The effective Skills setting governs agent installation: Automatic publishes, Review first leaves a pending change in Knowledge > Needs review while the task continues, and Off prevents agent installation. Human installation from the UI remains available. Do not ask an approval question for a pending receipt. Replacing an existing installation requires its current installation version, and preserves workspace customizations.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string", format: "uuid" },
        source: { type: "string", minLength: 1, maxLength: 2048 },
        expectedInstallationVersion: { type: "integer", minimum: 0 },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: ["operationId", "source", "reason"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      await input.authorize();
      const output = await input.install({
        operationId: args.operationId as string,
        source: args.source as string,
        ...(args.expectedInstallationVersion !== undefined
          ? { expectedInstallationVersion: args.expectedInstallationVersion as number }
          : {}),
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
