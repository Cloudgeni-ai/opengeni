import { useEffect, useRef, useState } from "react";

import {
  setSignOutRecordingsPrompt,
  type SignOutRecordingsChoice,
} from "@opengeni/react/meetings-recorder";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";

type Prompt = { recordings: number; resolve: (choice: SignOutRecordingsChoice) => void };

/**
 * Asked when someone signs out while recordings of theirs are still
 * uploading from this device: wait for the upload and stay signed in, or
 * discard the recordings and sign out.
 */
export function SignOutRecordingsDialog() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const chosen = useRef<SignOutRecordingsChoice>("wait");

  useEffect(
    () =>
      setSignOutRecordingsPrompt(
        ({ recordings }) =>
          new Promise<SignOutRecordingsChoice>((resolve) => {
            chosen.current = "wait";
            setPrompt({ recordings, resolve });
          }),
      ),
    [],
  );

  if (!prompt) return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        prompt.resolve(chosen.current);
        setPrompt(null);
      }}
      title="Recordings are still uploading"
      description={
        prompt.recordings === 1
          ? "A recording on this device hasn't finished uploading. Signing out now deletes it."
          : "Recordings on this device haven't finished uploading. Signing out now deletes them."
      }
      cancelLabel="Wait for upload"
      cancelAutoFocus
      confirmLabel="Discard and sign out"
      onConfirm={() => {
        chosen.current = "discard";
      }}
    />
  );
}
