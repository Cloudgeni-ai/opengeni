// Workspace settings → General → Meetings, over the console's workspace and
// its settings save. The rows themselves are @opengeni/react/meetings'.
import { resolveWorkspaceRecordingSettings } from "@opengeni/contracts";
import { useAppContext } from "@opengeni/react/app/app-context";
import { MeetingDefaultsView } from "@opengeni/react/meetings";
import { meetingViewerName } from "./viewer-name";

export function MeetingDefaultsSection({
  workspaceId,
  personal,
  canManage,
  onConnectModels,
}: {
  workspaceId: string;
  /** A Personal workspace has only its person, so visibility has nothing to choose. */
  personal: boolean;
  canManage: boolean;
  /** Opens where model accounts are added, for people who may add them. */
  onConnectModels?: (() => void) | undefined;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const viewer = context.accessContext;
  return (
    <MeetingDefaultsView
      workspaceId={workspaceId}
      settings={resolveWorkspaceRecordingSettings(workspace?.settings)}
      personal={personal}
      canManage={canManage}
      viewer={{ subjectId: viewer.subjectId, name: meetingViewerName(context) ?? "Me" }}
      onConnectModels={onConnectModels}
      onSave={async (next) => {
        const accepted = context.captureWorkspaceInvocation(workspaceId);
        if (!accepted) return false;
        const updated = await context.updateWorkspaceSettings(workspaceId, { recordings: next });
        return Boolean(updated) && context.ownsWorkspaceInvocation(workspaceId, accepted);
      }}
    />
  );
}
