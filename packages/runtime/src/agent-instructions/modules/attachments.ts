import { blocks, type AgentPromptModule } from "../types";

/** Files mounted for this turn. Placed last among modules: it varies per turn. */
export const attachmentsModule: AgentPromptModule = {
  id: "attachments",
  applies: (context) => context.resources.attachments,
  render: () =>
    blocks(
      "# Attached files",
      "File resources are mounted under .opengeni/files/<file-id>/ unless the session specifies another mount path. Attached files are mounted read-only; copy them before modifying.",
    ),
};
