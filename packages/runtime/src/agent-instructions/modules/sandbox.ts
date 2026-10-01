import {
  blocks,
  bullets,
  hasSandbox,
  type AgentPromptContext,
  type AgentPromptModule,
} from "../types";

function workspacePathRule(context: AgentPromptContext): string {
  const { managedSandbox, connectedMachine } = context.resources;
  if (managedSandbox && connectedMachine) {
    return "Use the active workspace path exactly as exposed to you. Managed sandboxes normally use `/workspace`; a Connected Machine instead uses its host-native workspace root, such as `/home/u/proj` or `C:/repo`. Both are valid inside a `sandbox:` link when they are the active workspace.";
  }
  return connectedMachine
    ? "Use the active workspace path exactly as exposed to you. A Connected Machine uses its host-native workspace root, such as `/home/u/proj` or `C:/repo`, and that root is valid inside a `sandbox:` link."
    : "Use the active workspace path exactly as exposed to you. Managed sandboxes normally use `/workspace`.";
}

function fileLinks(context: AgentPromptContext): string | null {
  if (context.renderer !== "opengeni") return null;
  return blocks(
    "## File links",
    "When referencing a real local source file or an explicitly requested local file, prefer a clickable markdown link.",
    bullets(
      "Clickable file links should look like [app.py](sandbox:/workspace/app.py:12): plain label, sandbox:/workspace/... target, with optional line number after the path.",
      "If a file path has spaces, wrap the target in angle brackets: [My Component.ts](<sandbox:/workspace/My Project/My Component.ts:3>).",
      workspacePathRule(context),
      context.resources.managedSandbox &&
        "In managed sandboxes, never link directly to `/tmp` or any file outside the current workspace. If a generated screenshot or artifact lives elsewhere, copy it into the current workspace before responding and link the workspace copy through its canonical sandbox path.",
      "Do not wrap markdown links in backticks, or put backticks inside the label or target. This confuses the markdown renderer.",
      "Do not use URIs like file://, vscode://, or https:// for local file links, and do not invent or translate the active workspace root.",
      "Do not provide ranges of lines.",
      "Avoid repeating the same filename multiple times when one grouping is clearer.",
    ),
  );
}

/** Any attached compute (managed sandbox or Connected Machine): shell, files, and file links. */
export const sandboxModule: AgentPromptModule = {
  id: "sandbox",
  applies: hasSandbox,
  render: (context) =>
    blocks(
      "# Working in the sandbox",
      "When a task needs files or commands, work inside the sandbox workspace with the filesystem and shell tools.",
      bullets(
        "Search text and files with `rg` or `rg --files` first; if `rg` is unavailable, use the next best tool.",
        "Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; they make the output noisy for the user.",
        "Exercise caution when escaping text for exec_command calls - backticks and `$()` passed to shell command input will still execute. DO NOT use escape sequences that risk accidental exposure of sensitive data in tool call outputs.",
        "When declaring env vars or script variables, always avoid common system options. Never repurpose `$HOME` or `$home`. Instead, use a task-specific variable name.",
      ),
      "## File editing constraints",
      "Use `apply_patch` for local file edits. Do not create or edit files with `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`. Do not use Python to read or write files when a simple shell command or `apply_patch` is enough.",
      "## Destructive commands",
      bullets(
        "Do not use `$HOME`, `~`, `/`, a workspace root, or another broad directory as the target of a recursive or destructive command.",
        "When creating temporary directories, prefer using `mktemp -d`, or `New-Item` in Powershell.",
        "When possible, avoid relying on unresolved environment variables, globs, or command substitutions to identify destructive targets. Use explicit, validated paths.",
      ),
      "Never run commands such as `rm -rf $HOME` or equivalent operations that could erase a home directory, repository, workspace, or other broad collection of user data.",
      fileLinks(context),
    ),
};
