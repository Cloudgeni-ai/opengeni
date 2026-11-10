import { prepareRecordingsForSignOut } from "@opengeni/react/meetings-recorder";
import { Button } from "@opengeni/react/ui/button";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import {
  createMemoryRecordingChunkStore,
  type RecordingChunkStore,
  type StoredRecording,
} from "@opengeni/sdk/recordings";
import { useState } from "react";

import { SignOutRecordingsDialog } from "@/components/sign-out-recordings-dialog";
import { KitSection, KitCanvas } from "../kit";

/*
 * DEV only. The production sign-out question and check. A store in memory
 * stands in for this browser's recordings: one is still uploading for the
 * first account and none for the second, and signing out only reports what
 * would happen.
 */

function pendingRecording(ownerId: string): StoredRecording {
  return {
    workspaceId: "northwind",
    recordingId: "weekly-planning",
    ownerId,
    create: {
      recordingId: "weekly-planning",
      title: "Weekly planning",
      startedAt: "2026-11-10T08:00:00.000Z",
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    },
    created: true,
    phase: "stopped",
    endedAt: "2026-11-10T08:42:00.000Z",
    chunkCounts: { 0: 504 },
    updatedAt: 0,
  };
}

function SampleAccount({ email, uploading }: { email: string; uploading: boolean }) {
  const [store] = useState<RecordingChunkStore>(() => createMemoryRecordingChunkStore());
  const [status, setStatus] = useState<string | null>(null);
  const signOut = async () => {
    if (uploading && (await store.listRecordings()).length === 0) {
      await store.putRecording(pendingRecording(email));
    }
    const proceed = await prepareRecordingsForSignOut(email, { store });
    setStatus(proceed ? "Signed out" : "Still signed in, uploading");
  };
  return (
    <SettingRow
      label={email}
      description={status ?? (uploading ? "1 recording uploading" : "Nothing uploading")}
      control={
        <Button variant="secondary" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      }
    />
  );
}

export default function SignOutRecordingsSection() {
  return (
    <KitSection sectionKey="page-sign-out-recordings">
      <KitCanvas>
        <Section title="Accounts">
          <SettingRowGroup>
            <SampleAccount email="ola@northwind.example" uploading />
            <SampleAccount email="kari@northwind.example" uploading={false} />
          </SettingRowGroup>
        </Section>
      </KitCanvas>
      <SignOutRecordingsDialog />
    </KitSection>
  );
}
