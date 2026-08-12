import {
  DEFAULT_FILE_RESOURCE_MOUNT_ROOT,
  type ComposerDraft,
  type FileAsset,
  type FileDownloadUrlResponse,
  type SaveComposerDraftRequest,
  type UploadFileInput,
} from "@opengeni/sdk";
import { ChatComposer, useComposer, useFileAttachments } from "@opengeni/react";
import { createRoot } from "react-dom/client";

import { MockOpenGeniClient } from "./mock";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "99999999-8888-4777-8666-555555555555";
const FILE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DRAFT_KEY = "opengeni:demo:composer-attachment-draft";
const FILE_KEY = "opengeni:demo:composer-attachment-file";
const VALID_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1xkAAAAASUVORK5CYII=";

const params = new URLSearchParams(window.location.search);
if (params.get("reset") === "1") {
  localStorage.removeItem(DRAFT_KEY);
  localStorage.removeItem(FILE_KEY);
}
const brokenPreview = params.get("preview") === "broken";

function emptyDraft(): ComposerDraft {
  return {
    revision: 0,
    text: "",
    resources: [],
    annotations: [],
    model: "gpt-5.2",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: null,
  };
}

function readStored<T>(key: string): T | null {
  const value = localStorage.getItem(key);
  return value ? (JSON.parse(value) as T) : null;
}

class AttachmentFixtureClient extends MockOpenGeniClient {
  override async getComposerDraft(
    _workspaceId: string,
    _sessionId: string,
  ): Promise<ComposerDraft> {
    return readStored<ComposerDraft>(DRAFT_KEY) ?? emptyDraft();
  }

  override async saveComposerDraft(
    _workspaceId: string,
    _sessionId: string,
    request: any,
  ): Promise<ComposerDraft> {
    const input = request as SaveComposerDraftRequest;
    const current = await this.getComposerDraft(WORKSPACE_ID, SESSION_ID);
    const saved: ComposerDraft = {
      revision: current.revision + 1,
      text: input.text,
      resources: input.resources.map((resource) =>
        resource.kind === "file"
          ? {
              ...resource,
              mountPath:
                resource.mountPath ?? `${DEFAULT_FILE_RESOURCE_MOUNT_ROOT}/${resource.fileId}`,
            }
          : resource,
      ),
      annotations: input.annotations,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      latencyMode: input.latencyMode,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(saved));
    document.documentElement.dataset.savedDraftResources = String(saved.resources.length);
    return saved;
  }

  override async uploadFile(workspaceId: string, input: UploadFileInput): Promise<FileAsset> {
    const sizeBytes = input.data instanceof Blob ? input.data.size : 0;
    const file: FileAsset = {
      id: FILE_ID,
      workspaceId,
      status: "ready",
      filename: input.filename,
      safeFilename: input.filename,
      contentType: input.contentType,
      sizeBytes,
      sha256: null,
      bucket: "demo-files",
      objectKey: FILE_ID,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    localStorage.setItem(FILE_KEY, JSON.stringify(file));
    return file;
  }

  override async getFile(_workspaceId: string, fileId: string): Promise<FileAsset> {
    const file = readStored<FileAsset>(FILE_KEY);
    if (!file || file.id !== fileId) throw new Error("file not found");
    return file;
  }

  override async createFileDownloadUrl(
    _workspaceId: string,
    _fileId: string,
  ): Promise<FileDownloadUrlResponse> {
    return {
      url: brokenPreview ? "/missing-composer-preview.png" : VALID_IMAGE_DATA_URL,
      expiresAt: "2026-08-12T12:00:00.000Z",
    };
  }
}

const client = new AttachmentFixtureClient();

function AttachmentHarness() {
  const attachments = useFileAttachments({ client, workspaceId: WORKSPACE_ID });
  const composer = useComposer(SESSION_ID, {
    client,
    workspaceId: WORKSPACE_ID,
    events: [],
    sendExtras: () => ({
      resources: attachments.readyResources,
      model: "gpt-5.2",
      reasoningEffort: "medium",
      latencyMode: "standard",
    }),
    sendBlocked: () => attachments.hasUnresolved,
  });

  return (
    <main className="og-root min-h-dvh bg-og-bg p-8 text-og-fg">
      <section
        data-testid="attachment-harness"
        data-attachment-count={attachments.attachments.length}
        data-ready-resource-count={attachments.readyResources.length}
        data-restored-resource-count={composer.restoredResources.length}
        data-draft-resource-count={composer.draft?.resources.length ?? 0}
        data-draft-revision={composer.draftRevision}
        className="mx-auto flex max-w-3xl flex-col gap-4"
      >
        <h1 className="text-og-md font-semibold">Durable composer attachments</h1>
        <button
          type="button"
          onClick={() => void composer.reloadDraft()}
          className="w-fit rounded-og-md border border-og-border px-3 py-2 text-og-xs"
        >
          Reload draft
        </button>
        <ChatComposer composer={composer} attachments={attachments} />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<AttachmentHarness />);
