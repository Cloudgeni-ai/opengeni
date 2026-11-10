// Recordings an account leaves on the phone when it signs out (CASA 6.6.1).
// Each account's unsent audio is in its own folder; signing out first asks
// whether to wait for the upload or discard it, and once the sign-out goes
// ahead the folder is deleted.
import { Alert } from "react-native";
import {
  prepareRecordingsForSignOut,
  type SignOutRecordingsChoice,
} from "@opengeni/react/recordings";
import { expoRecordingChunkStore, forgetRecordingStore } from "@opengeni/react-native/recordings";

/** The question, as the system alert: wait for the upload, or discard and sign out. */
export function askAboutRecordings({
  recordings,
}: {
  recordings: number;
}): Promise<SignOutRecordingsChoice> {
  return new Promise((resolve) => {
    Alert.alert(
      "Recordings are still uploading",
      recordings === 1
        ? "A recording on this device hasn't finished uploading. Signing out now deletes it."
        : "Recordings on this device haven't finished uploading. Signing out now deletes them.",
      [
        { text: "Wait for upload", style: "cancel", onPress: () => resolve("wait") },
        {
          text: "Discard and sign out",
          style: "destructive",
          onPress: () => resolve("discard"),
        },
      ],
      { cancelable: true, onDismiss: () => resolve("wait") },
    );
  });
}

/**
 * Before an account signs out: true to go ahead (nothing unsent, or the
 * person discarded it), false when they chose to wait for the upload. With
 * `ask: false` unsent recordings are discarded without asking.
 */
export async function prepareAccountRecordingsForSignOut(
  accountId: string,
  ask: boolean,
): Promise<boolean> {
  return await prepareRecordingsForSignOut(accountId, {
    store: expoRecordingChunkStore(accountId),
    ...(ask ? { prompt: askAboutRecordings } : { ask: false }),
  });
}

/** After an account signed out: delete its recordings folder, half-written files included. */
export function forgetAccountRecordings(accountId: string): void {
  try {
    forgetRecordingStore(accountId);
  } catch {
    // The folder is gone or can't be read; nothing more to remove.
  }
}
