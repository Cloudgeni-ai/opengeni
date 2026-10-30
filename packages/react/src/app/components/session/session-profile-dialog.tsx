/**
 * Edit a chat's profile: its name, a one-line description and an avatar.
 * Together they are what makes a long-lived chat read as a bot in the
 * sidebar and header. Only people see them; the agent works the same. The
 * agent can set them too, including an image it made, which this dialog can
 * keep or replace but not upload.
 */
import { useState } from "react";
import { SESSION_DESCRIPTION_MAX_LENGTH } from "@opengeni/contracts";
import type { SessionAvatar as SessionAvatarValue } from "@opengeni/sdk";

import { Field, FieldStack, TextArea, TextInput } from "../../../ui/field";
import { FormDialog } from "../../../ui/form-dialog";
import { SESSION_TITLE_MAX_LENGTH } from "../../lib/session-rename";
import { SessionAvatar, sessionAvatarFallbackHue } from "./session-avatar";
import {
  SessionAvatarPicker,
  sessionAvatarDraft,
  sessionAvatarDraftErrors,
  sessionAvatarFromDraft,
  sessionAvatarSeedHue,
} from "./session-avatar-picker";

export { SESSION_AVATAR_HUES } from "./session-avatar-picker";

export type SessionProfileValues = {
  title: string;
  description: string;
  avatar: SessionAvatarValue | null;
};

export function SessionProfileDialog({
  open,
  onOpenChange,
  workspaceId,
  seed,
  initial,
  title = "Edit profile",
  description = "A name, description and avatar help people find this chat and know what it does. The agent doesn't see them.",
  submitLabel = "Save",
  nameMaxLength = SESSION_TITLE_MAX_LENGTH,
  descriptionMaxLength = SESSION_DESCRIPTION_MAX_LENGTH,
  descriptionHint = "One line about what it's for, shown next to its name.",
  emptyAvatar,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** Keeps the default colour stable (the chat or template id). */
  seed: string;
  initial: SessionProfileValues;
  title?: string | undefined;
  description?: string | undefined;
  submitLabel?: string | undefined;
  nameMaxLength?: number | undefined;
  descriptionMaxLength?: number | undefined;
  descriptionHint?: string | undefined;
  /** What shows in place of the avatar when there is none (a project's folder). */
  emptyAvatar?: React.ReactNode | undefined;
  /** Resolve false to keep the dialog open (a field of the caller's is wrong). */
  onSubmit: (values: SessionProfileValues) => Promise<void | false>;
  /** Extra fields after the profile (a template's setup instructions). */
  children?: React.ReactNode | undefined;
}) {
  const fallbackHue = sessionAvatarSeedHue(sessionAvatarFallbackHue(seed));
  const [name, setName] = useState(initial.title);
  const [about, setAbout] = useState(initial.description);
  const [draft, setDraft] = useState(() => sessionAvatarDraft(initial.avatar, fallbackHue));
  const [nameError, setNameError] = useState<string | null>(null);
  const [avatarErrors, setAvatarErrors] = useState<{ emoji?: string; letters?: string }>({});
  const [opened, setOpened] = useState(open);
  // Each opening starts from what the chat has now.
  if (open !== opened) {
    setOpened(open);
    if (open) {
      setName(initial.title);
      setAbout(initial.description);
      setDraft(sessionAvatarDraft(initial.avatar, fallbackHue));
      setNameError(null);
      setAvatarErrors({});
    }
  }
  const initialImage = initial.avatar?.kind === "image" ? initial.avatar : null;
  const avatar = sessionAvatarFromDraft(draft, name, initialImage);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={title}
      description={description}
      submitLabel={submitLabel}
      pendingLabel="Saving…"
      cancelLabel="Cancel"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setNameError("Give it a name.");
          return false;
        }
        const errors = sessionAvatarDraftErrors(draft, name, initialImage);
        if (errors.emoji || errors.letters) {
          setAvatarErrors(errors);
          return false;
        }
        return (
          (await onSubmit({
            title: trimmed,
            description: about.trim(),
            avatar,
          })) !== false
        );
      }}
    >
      <FieldStack>
        <div className="flex items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center">
            {avatar ? (
              <SessionAvatar
                avatar={avatar}
                name={name || "Bot"}
                workspaceId={workspaceId}
                seed={seed}
                size="lg"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex size-12 items-center justify-center rounded-lg border border-dashed border-border-strong text-xs text-fg-subtle"
              >
                {emptyAvatar ?? "None"}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <Field label="Name" error={nameError ?? undefined}>
              <TextInput
                value={name}
                maxLength={nameMaxLength}
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
              />
            </Field>
          </div>
        </div>
        <Field label="Description" optional hint={descriptionHint}>
          <TextArea
            value={about}
            rows={2}
            maxLength={descriptionMaxLength}
            onChange={(event) => setAbout(event.target.value)}
          />
        </Field>
        <SessionAvatarPicker
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setAvatarErrors({});
          }}
          name={name}
          image={initialImage}
          errors={avatarErrors}
        />
        {children}
      </FieldStack>
    </FormDialog>
  );
}
