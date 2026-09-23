import type { AttemptToolDefinition } from "@opengeni/codemode";
import { z } from "zod";
import type { SkillWriteReceipt } from "@opengeni/contracts";

export const SkillRemoveRequest = z
  .object({
    operationId: z.uuid(),
    skillId: z.uuid(),
    expectedRevisionId: z.uuid().nullable(),
    expectedScopeVersion: z.number().int().positive(),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export function createSkillRemoveAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  remove: (request: z.infer<typeof SkillRemoveRequest>) => Promise<SkillWriteReceipt>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "skill_remove" },
    modelName: "skill_remove",
    codemodePath: ["opengeni", "skill_remove"],
    title: "Permanently remove Skill",
    description:
      "Permanently delete a saved Skill and ALL its stored revisions, not a recoverable hide. Conversations remain unchanged. Read the exact Skill first; supply its current active revision and scope version. Built-in, repository and inline session Skills cannot be removed. Automatic applies deletion; Review first retains an explicitly labeled deletion proposal for human review in Knowledge > Needs review; Off refuses changes. Reuse the same operationId and exact arguments after an uncertain result. Never report a pending proposal as deleted.",
    inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(SkillRemoveRequest))),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      await input.authorize();
      const output = await input.remove(SkillRemoveRequest.parse(args));
      const text = JSON.stringify(output);
      return {
        isError: false,
        content: [{ type: "text", text }],
        structuredContent: JSON.parse(text),
      };
    },
  };
}
