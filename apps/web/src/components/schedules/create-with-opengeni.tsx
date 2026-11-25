/**
 * "Create with Opengeni" ("Create with Geni" in the simplified interface): say
 * what should happen and how often, and a chat researches the rest
 * (repositories, secrets, integrations) and creates the schedule with its
 * scheduling tools. The dialog is the shared start-chat-dialog.
 */
import { SparklesIcon } from "lucide-react";

import { Button } from "@opengeni/react/ui/button";
import { useAppContext } from "@opengeni/react/app/app-context";
import { useSimplifiedInterface } from "@opengeni/react/app/lib/simplified-interface";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";

import { useStartChatDialog } from "../start-chat-dialog";

import { scheduleAgentOpeningMessage } from "./schedule-model";

/** Starting the chat needs sessions:create; the agent's create needs scheduled_tasks:manage. */
export function useCanCreateScheduleWithAgent(workspaceId: string): boolean {
  const { accessContext } = useAppContext();
  return (
    hasWorkspacePermission(accessContext, workspaceId, "sessions:create") &&
    hasWorkspacePermission(accessContext, workspaceId, "scheduled_tasks:manage")
  );
}

/** Opens the dialog; mounts it on first use so the list doesn't load the model catalog. */
export function useCreateWithOpenGeni(workspaceId: string) {
  const { simplified, productName } = useSimplifiedInterface();
  return useStartChatDialog(workspaceId, {
    title: `Create an automation with ${productName}`,
    description: simplified
      ? "It starts a chat, finds the apps the automation needs, and creates it. It asks you only for what it can't find."
      : "It starts a chat, finds the repositories, secrets and connected tools the automation needs, and creates it. It asks you only for what it can't find.",
    fieldLabel: "What should happen, and how often?",
    placeholder: simplified
      ? "Every Monday morning, draft a short update for each client from last week's emails"
      : "Every weekday morning, summarize new Sentry errors and post them to #eng",
    emptyError: "Say what should happen and how often.",
    openingMessage: scheduleAgentOpeningMessage,
  });
}

export function CreateWithOpenGeniButton({ onClick }: { onClick: () => void }) {
  const { productName } = useSimplifiedInterface();
  return (
    <Button type="button" variant="outline" onClick={onClick} className="pointer-coarse:h-11">
      <SparklesIcon aria-hidden="true" />
      Create with {productName}
    </Button>
  );
}
