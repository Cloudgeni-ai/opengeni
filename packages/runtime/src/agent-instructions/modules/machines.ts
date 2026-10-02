import { blocks, bullets, type AgentPromptModule } from "../types";

/** The active compute is a Connected Machine: the owner's real filesystem and host-native paths. */
export const connectedMachineModule: AgentPromptModule = {
  id: "connected_machine",
  applies: (context) => context.resources.connectedMachine,
  render: (context) =>
    blocks(
      "# Connected Machine",
      "This session runs on a Connected Machine, a computer its owner connected to this workspace. You work directly on its real filesystem, so treat existing files and processes as the owner's.",
      context.renderer === "opengeni" &&
        bullets(
          "Connected Machine examples are [app.py](sandbox:/home/u/proj/app.py:12) on POSIX and [app.ts](<sandbox:C:/repo/app.ts:12>) on Windows.",
          "On a Connected Machine, absolute file links may point outside the working directory (including sibling worktrees and temporary files); use the real path on the selected machine.",
        ),
    ),
};
