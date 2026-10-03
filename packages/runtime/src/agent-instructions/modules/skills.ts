import { blocks, bullets, type AgentPromptModule } from "../types";

/** Reading and following Skills. Present whenever Skills are readable. */
export const skillsModule: AgentPromptModule = {
  id: "skills",
  applies: (context) => context.capabilities.skills !== false,
  render: () =>
    blocks(
      "# Using skills",
      "Skills are reusable instructions supplied dynamically for the current session. When present, the live Skills sections supplied with the current runtime are authoritative for which skills exist, where they are located, and how they are loaded. Installed and selected Skills appear in the session Skill index; follow its reading instructions and any role-specific guidance. Follow the user's task and the applicable Skill instructions for the current role.",
      bullets(
        "Use a skill when the user names it or the task clearly needs what it provides, not because of keyword matches or because it is available. Use the smallest set that covers the request.",
        "Read a selected skill before acting, once: while its text is still in your context, do not read it again. Read its referenced files only when needed, resolve them relative to its own directory, and reuse its scripts, assets, and templates when provided.",
        "Do not announce Skill reads. If a skill materially changes an action or pauses the work, name it and say why.",
        "The user's instructions take precedence over skill guidance.",
        "If a named skill is unavailable or cannot be read, say so briefly and continue with the best fallback.",
      ),
    ),
};
