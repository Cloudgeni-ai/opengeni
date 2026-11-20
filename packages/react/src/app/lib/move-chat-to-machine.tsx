import { t } from "./console-text";
import type { MachineView } from "../../machines";
import { machineDisplayName } from "../../sandbox-label-model";
import {
  moveChatToMachine as moveChatToNamedMachine,
  type MoveChatToMachineResult,
} from "../../machine-request-model";
import type { SendMessageInput } from "@opengeni/sdk";

import type { ChatSendContext } from "../components/capabilities/session-github-repositories";

export {
  isPersonalMachine,
  machineUseMessage,
  type MoveChatToMachineResult,
} from "../../machine-request-model";

/**
 * Move a chat onto a machine the way a person asks for it; see the shared
 * `moveChatToMachine` in `machine-request-model`, which the native card uses too.
 */
export async function moveChatToMachine(input: {
  machine: MachineView;
  chat: ChatSendContext;
  canMessage: boolean;
  /** Where the chat runs now, to move back to if a personal machine's consent fails. */
  previousSandboxId?: string | null | undefined;
  attach: (sandboxId: string) => Promise<boolean>;
  sendMessage: (message: SendMessageInput) => Promise<{ payload?: unknown }>;
}): Promise<MoveChatToMachineResult> {
  return await moveChatToNamedMachine({ ...input, name: machineDisplayName(t, input.machine) });
}
