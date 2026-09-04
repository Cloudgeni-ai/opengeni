import {
  ChatComposer,
  LightboxProvider,
  useFileAttachments,
  type ComposerState,
} from "@opengeni/react";
import type { FileAsset, OpenGeniClient } from "@opengeni/sdk";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "../src/styles.css";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs><linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#172554"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs>
  <rect width="640" height="360" rx="24" fill="url(#bg)"/>
  <rect x="72" y="72" width="496" height="216" rx="18" fill="#020617" fill-opacity=".72" stroke="#67e8f9" stroke-opacity=".55"/>
  <circle cx="112" cy="112" r="10" fill="#22d3ee"/>
  <path d="M112 244l92-82 64 52 74-70 186 100H112z" fill="#5eead4" fill-opacity=".78"/>
  <text x="320" y="325" fill="#ecfeff" font-family="system-ui,sans-serif" font-size="20" text-anchor="middle">Restored pasted screenshot</text>
</svg>`;
const IMAGE_DATA_URL = `data:image/svg+xml,${encodeURIComponent(IMAGE_SVG)}`;
const IMAGE_ASSET: FileAsset = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: WORKSPACE_ID,
  status: "ready",
  filename: "pasted-screenshot.svg",
  safeFilename: "pasted-screenshot.svg",
  contentType: "image/svg+xml",
  sizeBytes: IMAGE_SVG.length,
  sha256: null,
  bucket: "private",
  objectKey: "workspaces/fixture/files/pasted-screenshot.svg",
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

type AttachmentClient = Pick<OpenGeniClient, "uploadFile" | "createFileDownloadUrl">;

function RestoredAttachmentPreviewFixture() {
  const [route, setRoute] = useState<"new" | "other">("new");
  const [draftHasFile, setDraftHasFile] = useState(false);
  const [previewRequests, setPreviewRequests] = useState(0);
  const client = useMemo<AttachmentClient>(
    () => ({
      uploadFile: async () => {
        setDraftHasFile(true);
        return IMAGE_ASSET;
      },
      createFileDownloadUrl: async () => {
        setPreviewRequests((current) => current + 1);
        return {
          url: IMAGE_DATA_URL,
          expiresAt: "2026-09-04T01:00:00.000Z",
        };
      },
    }),
    [],
  );

  return (
    <main className="og-root min-h-dvh bg-og-bg p-8 text-og-fg">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Restored attachment preview</h1>
            <p className="mt-1 text-sm text-og-fg-muted">
              Simulates leaving and returning to the new-session route.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-og-md border border-og-border px-3 py-2 text-sm"
              onClick={() => setRoute("new")}
            >
              New session
            </button>
            <button
              type="button"
              className="rounded-og-md border border-og-border px-3 py-2 text-sm"
              onClick={() => setRoute("other")}
            >
              Other session
            </button>
          </div>
        </div>

        {route === "new" ? (
          <NewSessionComposer client={client} restoreDraftFile={draftHasFile} />
        ) : (
          <section className="rounded-og-lg border border-og-border bg-og-surface-1 p-8">
            <h2 className="font-medium">Other session</h2>
            <p className="mt-2 text-sm text-og-fg-muted">
              Return to New session to restore the unsent image.
            </p>
          </section>
        )}

        <output data-testid="preview-request-count" className="mt-6 block text-sm text-og-fg-muted">
          Preview requests: {previewRequests}
        </output>
      </div>
    </main>
  );
}

function NewSessionComposer({
  client,
  restoreDraftFile,
}: {
  client: AttachmentClient;
  restoreDraftFile: boolean;
}) {
  const [value, setValue] = useState("");
  const attachments = useFileAttachments({ client, workspaceId: WORKSPACE_ID });
  const restoreReadyFiles = attachments.restoreReadyFiles;
  const [restoreOnMount] = useState(() => restoreDraftFile);

  useEffect(() => {
    if (restoreOnMount) restoreReadyFiles([IMAGE_ASSET]);
  }, [restoreOnMount, restoreReadyFiles]);

  const composer = useMemo<ComposerState>(
    () => ({
      value,
      setValue,
      hasDraftContent: () => value.trim().length > 0 || attachments.attachments.length > 0,
      send: async () => true,
      steer: async () => true,
      sending: false,
      canSend: value.trim().length > 0 || attachments.readyResources.length > 0,
      pause: async () => {},
      pausing: false,
      resume: async () => {},
      resumeScope: async () => {},
      resuming: false,
      draft: null,
      draftRevision: 0,
      draftLoading: false,
      draftSaving: false,
      draftConflict: null,
      applyDraft: () => {},
      reloadDraft: async () => {},
      resolveDraftConflict: async () => {},
      restoredResources: [],
      removeRestoredResource: () => {},
      error: null,
      clearError: () => {},
    }),
    [attachments.attachments.length, attachments.readyResources.length, value],
  );

  return (
    <LightboxProvider>
      <section className="rounded-og-lg border border-og-border bg-og-surface-1 p-6">
        <h2 className="mb-4 font-medium">What should the agent do?</h2>
        <ChatComposer
          composer={composer}
          attachments={attachments}
          placeholder="Describe a task for the agent…"
        />
      </section>
    </LightboxProvider>
  );
}

createRoot(document.getElementById("root")!).render(<RestoredAttachmentPreviewFixture />);
