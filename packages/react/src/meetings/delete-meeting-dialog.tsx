import { useOpenGeniText } from "../messages/runtime";
import { toast } from "sonner";
import type { Recording } from "@opengeni/contracts";

import { ConfirmDialog } from "../ui/confirm-dialog";

/** "Delete 'Weekly sync'?": removes the audio, every transcript and the speaker names. */
export function DeleteMeetingDialog({
  recording,
  onClose,
  onDelete,
  onDeleted,
}: {
  recording: Pick<Recording, "id" | "title"> | null;
  onClose: () => void;
  onDelete: (recordingId: string) => Promise<void>;
  onDeleted: () => void;
}) {
  const msg = useOpenGeniText();
  return (
    <ConfirmDialog
      open={recording !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        recording
          ? msg("meetings.deleteDialog.deleteTitle", { title: recording.title })
          : msg("meetings.deleteDialog.deleteMeeting")
      }
      description={msg("meetings.deleteDialog.thisDeletesTheAudioEvery")}
      confirmLabel={msg("meetings.deleteDialog.deleteMeeting2")}
      pendingLabel={msg("meetings.deleteDialog.deleting")}
      onConfirm={async () => {
        if (!recording) return;
        try {
          await onDelete(recording.id);
        } catch (error) {
          toast.error(msg("meetings.deleteDialog.couldnTDeleteThisMeeting"), {
            description: error instanceof Error ? error.message : undefined,
          });
          return false;
        }
        toast.success(msg("meetings.deleteDialog.meetingDeleted"));
        onDeleted();
      }}
    />
  );
}
