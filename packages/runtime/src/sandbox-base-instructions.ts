import { getDefaultSandboxInstructions } from "@openai/agents/sandbox";

const SDK_REPOSITORY_INSTRUCTION =
  "- Look for AGENTS.md files that apply to the files you are reading or editing.\n";

/**
 * Exact SDK default lines Opengeni extends in place, so the preamble keeps its
 * shape and the additions load only with a sandbox (managed or Connected
 * Machine), never in a sandbox-less chat.
 *
 * - Workspace line: an agent's own scratch scripts, unrequested tests, caches
 *   and tools it downloads for its checks end up in the user's project unless
 *   told otherwise, where they clutter the result, can trip the project's own
 *   checks and can break copying or packaging it.
 * - Validation line: a fix to something already running is only done when the
 *   running instance uses it; agents otherwise stop after unit tests and report
 *   the restart as left over.
 */
const SDK_LINE_EXTENSIONS: ReadonlyArray<readonly [line: string, addition: string]> = [
  [
    "- Make changes inside the workspace unless the user explicitly asks for another location.",
    " Keep your own scratch work out of the user's project: put throwaway scripts and tests, caches, and browsers, runtimes or libraries installed only for your checks in a temporary directory outside it, and remove them when done. Tests the user asked for or the project expects belong in it.",
  ],
  [
    "- Verify changes when practical, especially after editing code, tests, build scripts, generated artifacts, or configuration.",
    " For a change to something already running, such as a service, worker or scheduled job, restart or reload the process that actually serves it, exercise the real entry point and check what the user asked about; unit tests alone do not show it works. Ask first only if a restart could disrupt others.",
  ],
];

/**
 * The sandbox agent's base instructions: the SDK default without its line
 * telling agents to look for AGENTS.md files. That line sends every agent,
 * even one writing a document into an empty sandbox, to scan for AGENTS.md
 * first, which costs a model step and usually finds nothing; an agent cannot
 * tell up front whether it is in a code repository. The remaining lines on how
 * to follow repository instructions an agent does meet stay, and two lines
 * gain a clause (see `SDK_LINE_EXTENSIONS`). The text is static, so it never
 * varies within a session.
 */
export function sandboxBaseInstructions(): string {
  const sdkDefault = getDefaultSandboxInstructions();
  if (!sdkDefault.includes(SDK_REPOSITORY_INSTRUCTION)) {
    throw new Error(
      "The SDK default sandbox instructions no longer contain the AGENTS.md line Opengeni removes; review sandbox-base-instructions.ts.",
    );
  }
  let text = sdkDefault.replace(SDK_REPOSITORY_INSTRUCTION, "");
  for (const [line, addition] of SDK_LINE_EXTENSIONS) {
    const lines = text.split("\n");
    const index = lines.indexOf(line);
    if (index < 0 || lines.lastIndexOf(line) !== index) {
      throw new Error(
        `The SDK default sandbox instructions no longer contain exactly one line Opengeni extends ("${line}"); review sandbox-base-instructions.ts.`,
      );
    }
    lines[index] = `${line}${addition}`;
    text = lines.join("\n");
  }
  return text;
}
