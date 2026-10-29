/**
 * A project's profile: its name, a description and an avatar, edited with the
 * same dialog a chat's profile uses. Projects are shared with the workspace,
 * so everyone sees the avatar in place of the folder icon and the description
 * when they point at the project. Agents can set both with project_update.
 */
import { FolderIcon } from "lucide-react";
import type { Channel, UpdateChannelRequest } from "@opengeni/sdk";

import { SessionProfileDialog } from "../session/session-profile-dialog";
import { CHANNEL_NAME_MAX_LENGTH } from "./channel-create-dialog";

/** The API's project description limit. */
export const PROJECT_DESCRIPTION_MAX_LENGTH = 2000;

/** The profile dialog for one project, saving only what changed. */
export function ProjectProfileDialog({
  project,
  open,
  onOpenChange,
  update,
}: {
  project: Channel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves false when the change was refused (for example a taken name). */
  update: (change: UpdateChannelRequest) => Promise<boolean>;
}) {
  const description = project.description ?? "";
  const avatar = project.avatar ?? null;
  return (
    <SessionProfileDialog
      open={open}
      onOpenChange={onOpenChange}
      workspaceId={project.workspaceId}
      seed={project.id}
      initial={{ title: project.name, description, avatar }}
      title="Edit project"
      description="Everyone in this workspace sees the project's name, description and avatar."
      nameMaxLength={CHANNEL_NAME_MAX_LENGTH}
      descriptionMaxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
      descriptionHint="What belongs here, shown when you point at the project."
      emptyAvatar={<FolderIcon className="size-5" />}
      onSubmit={async (values) => {
        const change: UpdateChannelRequest = {};
        if (values.title !== project.name) change.name = values.title;
        if (values.description !== description) change.description = values.description || null;
        if (JSON.stringify(values.avatar) !== JSON.stringify(avatar)) change.avatar = values.avatar;
        if (Object.keys(change).length === 0) return;
        return (await update(change)) ? undefined : false;
      }}
    />
  );
}
