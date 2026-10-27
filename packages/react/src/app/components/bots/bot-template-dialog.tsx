/**
 * Create or change a bot template: the new bot's name, description and
 * avatar, and the setup instructions that become its chat's first message.
 */
import { useState } from "react";
import { BOT_TEMPLATE_SETUP_INSTRUCTIONS_MAX_LENGTH } from "@opengeni/contracts";
import type { SessionAvatar } from "@opengeni/sdk";

import { Field, TextArea } from "../../../ui/field";
import { SessionProfileDialog } from "../session/session-profile-dialog";

export type BotTemplateValues = {
  name: string;
  description: string;
  avatar: SessionAvatar | null;
  setupInstructions: string;
};

export function BotTemplateDialog({
  open,
  onOpenChange,
  workspaceId,
  seed,
  mode,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  seed: string;
  /** `save`: from a chat; `new`: from scratch; `edit`: a saved template. */
  mode: "save" | "new" | "edit";
  initial: BotTemplateValues;
  onSubmit: (values: BotTemplateValues) => Promise<void>;
}) {
  const [setup, setSetup] = useState(initial.setupInstructions);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [opened, setOpened] = useState(open);
  if (open !== opened) {
    setOpened(open);
    if (open) {
      setSetup(initial.setupInstructions);
      setSetupError(null);
    }
  }
  return (
    <SessionProfileDialog
      open={open}
      onOpenChange={onOpenChange}
      workspaceId={workspaceId}
      seed={seed}
      title={
        mode === "edit"
          ? "Edit bot template"
          : mode === "save"
            ? "Save as bot template"
            : "New bot template"
      }
      description={
        mode === "save"
          ? "Anyone in the workspace can start a bot like this one from it. Its chat history isn't included."
          : "Starting from it opens a new chat with the setup instructions as its first message."
      }
      submitLabel={mode === "edit" ? "Save" : "Save template"}
      initial={{
        title: initial.name,
        description: initial.description,
        avatar: initial.avatar,
      }}
      onSubmit={async (values) => {
        const trimmed = setup.trim();
        if (!trimmed) {
          setSetupError("Say what the new bot should do to set itself up.");
          return false;
        }
        await onSubmit({
          name: values.title,
          description: values.description,
          avatar: values.avatar,
          setupInstructions: trimmed,
        });
      }}
    >
      <Field
        label="Setup instructions"
        error={setupError ?? undefined}
        hint={
          mode === "save"
            ? "What the new bot should set up and ask about. Tip: ask the agent in this chat to save itself as a bot template, and it writes these from what it knows."
            : "What the new bot should set up (Skills, connections, automations, machines) and what to ask the person first."
        }
      >
        <TextArea
          value={setup}
          rows={8}
          maxLength={BOT_TEMPLATE_SETUP_INSTRUCTIONS_MAX_LENGTH}
          placeholder="You are our release manager. First ask which repositories you look after and how releases work today. Then install the Skills you need, connect GitHub, and set up a weekly release check."
          onChange={(event) => {
            setSetup(event.target.value);
            setSetupError(null);
          }}
        />
      </Field>
    </SessionProfileDialog>
  );
}
