import { getDefaultSandboxInstructions } from "@openai/agents/sandbox";

const SDK_REPOSITORY_INSTRUCTION =
  "- Look for AGENTS.md files that apply to the files you are reading or editing.\n";

/**
 * The sandbox agent's base instructions: the SDK default without its line
 * telling agents to look for AGENTS.md files. That line sends every agent,
 * even one writing a document into an empty sandbox, to scan for AGENTS.md
 * first, which costs a model step and usually finds nothing; an agent cannot
 * tell up front whether it is in a code repository. The remaining lines on how
 * to follow repository instructions an agent does meet stay. The text is
 * static, so it never varies within a session.
 */
export function sandboxBaseInstructions(): string {
  const sdkDefault = getDefaultSandboxInstructions();
  if (!sdkDefault.includes(SDK_REPOSITORY_INSTRUCTION)) {
    throw new Error(
      "The SDK default sandbox instructions no longer contain the AGENTS.md line Opengeni removes; review sandbox-base-instructions.ts.",
    );
  }
  return sdkDefault.replace(SDK_REPOSITORY_INSTRUCTION, "");
}
