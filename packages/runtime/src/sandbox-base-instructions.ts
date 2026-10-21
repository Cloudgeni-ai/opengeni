import { getDefaultSandboxInstructions } from "@openai/agents/sandbox";

const SDK_REPOSITORY_INSTRUCTION =
  "- Look for AGENTS.md files that apply to the files you are reading or editing.";

const REPOSITORY_INSTRUCTION =
  "- In a code repository, look for AGENTS.md files that apply to the files you are reading or editing. A workspace with no repository has none, so do not search for them there.";

/**
 * The sandbox agent's base instructions: the SDK default, except that agents
 * look for repository instructions only where a repository exists. The SDK
 * default sends every agent, even one writing a document into an empty
 * workspace, to scan for AGENTS.md first, which costs a model step and finds
 * nothing. The text is static, so it never varies within a session.
 */
export function sandboxBaseInstructions(): string {
  const sdkDefault = getDefaultSandboxInstructions();
  if (!sdkDefault.includes(SDK_REPOSITORY_INSTRUCTION)) {
    throw new Error(
      "The SDK default sandbox instructions no longer contain the AGENTS.md line Opengeni rewords; review sandbox-base-instructions.ts.",
    );
  }
  return sdkDefault.replace(SDK_REPOSITORY_INSTRUCTION, REPOSITORY_INSTRUCTION);
}
