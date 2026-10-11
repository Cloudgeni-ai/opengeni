import { blocks, type AgentPromptModule } from "../types";

/** Files mounted for this turn. Placed last among modules: it varies per turn. */
export const attachmentsModule: AgentPromptModule = {
  id: "attachments",
  applies: (context) => context.resources.attachments,
  render: () =>
    blocks(
      "# Attached files",
      "File resources are mounted under .opengeni/files/<file-id>/ unless the session specifies another mount path. Attached files are mounted read-only; copy them before modifying. Files attached to the session stay mounted on every turn and may be old; treat one as part of the current request only when the latest message refers to it.",
    ),
};
