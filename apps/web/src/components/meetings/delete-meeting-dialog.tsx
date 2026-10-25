import { toast } from "sonner";
import type { Recording } from "@opengeni/contracts";

import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";

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
  return (
    <ConfirmDialog
      open={recording !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={recording ? `Delete “${recording.title}”?` : "Delete meeting?"}
      description="This deletes the audio, every transcript and the speaker names for this meeting. It can't be undone."
      confirmLabel="Delete meeting"
      pendingLabel="Deleting…"
      onConfirm={async () => {
        if (!recording) return;
        try {
          await onDelete(recording.id);
        } catch (error) {
          toast.error("Couldn't delete this meeting", {
            description: error instanceof Error ? error.message : undefined,
          });
          return false;
        }
        toast.success("Meeting deleted");
        onDeleted();
      }}
    />
  );
}
