/**
 * What stands for a project in lists: its avatar, or a folder when it has
 * none. Kept apart from the profile dialog so lists don't load the editor.
 */
import { FolderIcon, FolderOpenIcon } from "lucide-react";
import type { Channel } from "@opengeni/sdk";

import { cn } from "../../lib/utils";
import { SessionAvatar } from "../session/session-avatar";

type ProjectLike = Pick<Channel, "id" | "name" | "workspaceId"> & {
  avatar?: Channel["avatar"] | undefined;
};

/** The folder is open while the project's section is expanded. */
export function ProjectGlyph({
  project,
  open = false,
  className,
}: {
  project: ProjectLike | null | undefined;
  open?: boolean | undefined;
  className?: string | undefined;
}) {
  if (project?.avatar) {
    return (
      <SessionAvatar
        avatar={project.avatar}
        name={project.name}
        workspaceId={project.workspaceId}
        seed={project.id}
        size="xs"
        className={className}
      />
    );
  }
  const Icon = open ? FolderOpenIcon : FolderIcon;
  return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />;
}
