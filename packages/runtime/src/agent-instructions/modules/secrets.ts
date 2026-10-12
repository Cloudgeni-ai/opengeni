import { blocks, bullets, sentences, toolAvailable, type AgentPromptModule } from "../types";

/**
 * Always-on secrets doctrine: at most six lines under the heading. Renders
 * only when the capability is on and the runtime resolves references for the
 * attempt (`resources.secretReferences`). Each tool-naming clause renders
 * unless the attempt proved its tool absent; playbooks live in the
 * `opengeni-secrets` Skill.
 */
export const secretsModule: AgentPromptModule = {
  id: "secrets",
  applies: (context) => context.capabilities.secrets && context.resources.secretReferences === true,
  render: (context) => {
    const search = toolAvailable(context, "secret_search");
    const save = toolAvailable(context, "secret_save");
    const ladder = [
      "reuse a saved browser session",
      "sign in with the saved login and its `/otp` code",
      save && "after signing in, enroll your own 2FA and save it with `secret_save`",
      "get email or SMS codes through connected tools",
      save &&
        "when the task allows creating accounts, create the account without asking, saving a generated password with `secret_save` first",
    ].filter((step): step is string => typeof step === "string");
    return blocks(
      "# Secrets",
      bullets(
        sentences(
          "Use saved passwords, keys and codes by reference: `{{secret:Item}}`, `{{secret:Item/field}}` or `{{secret:Vault/Item/field}}`, plus `/otp` for the current one-time code (`{{secret:GitHub/otp}}`).",
          "Write them directly in shell commands, browser typing, files and tool calls; they resolve only where they execute and stay references everywhere else, so use them freely.",
          search && "Find saved items and their ready references with `secret_search`.",
        ),
        `Sign in yourself, in this order: ${ladder.join("; ")}.`,
        "Solve CAPTCHAs and other verification challenges yourself, retrying and trying alternatives as needed; never hand them to the user.",
        sentences(
          "Never ask for passwords, keys or codes in chat or in a plain text question.",
          context.capabilities.humanInput &&
            'Ask only for what only the user has, with a `kind: "secret"` question in `request_human_input`; a tool error about a missing secret already contains that call, so make it, adjusting only `saveTo` or `prompt`, and continue with the returned reference.',
        ),
        toolAvailable(context, "interaction_request_human") &&
          "Hand the browser to the user with `interaction_request_human` only for push approvals or hardware keys.",
        context.capabilities.skills !== false &&
          search &&
          "For playbooks, read the `opengeni-secrets` skill.",
      ),
    );
  },
};
