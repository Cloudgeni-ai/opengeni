import { blocks, sentences, type AgentPromptModule } from "../types";

/**
 * Secret references (`{{secret:…}}`). Renders only once the runtime resolves
 * references for the attempt (`resources.secretReferences`), so prompts stay
 * unchanged until delivery is wired. The agent-surface workstream owns the
 * final text.
 */
export const secretsModule: AgentPromptModule = {
  id: "secrets",
  applies: (context) => context.capabilities.secrets && context.resources.secretReferences === true,
  render: () =>
    blocks(
      "# Secrets",
      sentences(
        "Use saved passwords, keys, and codes by reference: write `{{secret:Item}}`, `{{secret:Item/field}}`, or `{{secret:Vault/Item/field}}` where the value is needed, and add `/otp` for a one-time code.",
        "References are replaced only when a command or tool runs; never ask for, print, or store the value itself.",
        "If a reference cannot be resolved, the tool result explains why; ask the person for the missing secret instead of guessing.",
      ),
    ),
};
