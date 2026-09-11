import type { FileAsset } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import {
  FileTextIcon,
  Loader2Icon,
  UploadIcon,
  RefreshCwIcon,
  ArrowUpRightIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentKnowledgePage } from "@/components/knowledge/agent-knowledge-page";
import { KnowledgeBrowser } from "@/components/knowledge/knowledge-browser";
import { KnowledgeCard } from "@/components/knowledge/knowledge-card";
import { FileSourceText } from "@/components/knowledge/file-source-text";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { formatBytes } from "@/lib/format";
import type { DocumentAuthorityKind } from "@/types";

type KnowledgeFilesProps = {
  workspaceId: string;
  authorityKind?: DocumentAuthorityKind;
  returnToBrain?: boolean;
};

/** Historical /documents links keep the common Knowledge navigation. */
export function DocumentsRoute(props: KnowledgeFilesProps) {
  return (
    <AgentKnowledgePage workspaceId={props.workspaceId} section="files">
      <KnowledgeFilesPanel {...props} />
    </AgentKnowledgePage>
  );
}

export function KnowledgeFilesPanel({ workspaceId, authorityKind }: KnowledgeFilesProps) {
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId) ?? null;
  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  const [scope, setScope] = useState<DocumentAuthorityKind>(
    authorityKind ?? (personal ? "personal" : "workspace"),
  );
  const [files, setFiles] = useState<FileAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selectedFile, setSelectedFile] = useState<FileAsset | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const requestVersion = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const canManageKnowledge = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "documents:manage",
  );
  const canUpload =
    context.clientConfig.fileUploads.enabled &&
    hasWorkspacePermission(context.accessContext, workspaceId, "files:upload") &&
    canManageKnowledge;
  const canWriteOrganization = Boolean(
    workspace?.accountId &&
    hasAccountPermission(context.accessContext, workspace.accountId, "account:admin"),
  );
  const fileScope = scope === "personal" ? "personal" : "workspace";
  useEffect(() => {
    let current = true;
    requestVersion.current += 1;
    setFiles([]);
    setCursor(null);
    setError(null);
    if (scope === "organization") {
      setBusy(false);
      return;
    }
    setBusy(true);
    void context.client
      .listFiles(workspaceId, { scope: fileScope, limit: 30 })
      .then((result) => {
        if (current) {
          setFiles(result.files);
          setCursor(result.nextCursor);
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [context.client, workspaceId, scope, fileScope, refresh]);

  async function more() {
    if (!cursor || busy) return;
    const version = requestVersion.current;
    setBusy(true);
    setError(null);
    try {
      const result = await context.client.listFiles(workspaceId, {
        scope: fileScope,
        limit: 30,
        cursor,
      });
      if (active.current && version === requestVersion.current) {
        setFiles((prior) => [...prior, ...result.files]);
        setCursor(result.nextCursor);
      }
    } catch (reason) {
      if (active.current && version === requestVersion.current) setError(String(reason));
    } finally {
      if (active.current && version === requestVersion.current) setBusy(false);
    }
  }
  async function upload(selected: FileList | null) {
    if (
      uploading ||
      !selected?.length ||
      !canUpload ||
      (scope === "organization" && !canWriteOrganization)
    )
      return;
    const destination = scope;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(selected)) {
        const asset = await context.client.uploadFile(workspaceId, {
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          data: file,
          scope: destination === "personal" ? "personal" : "workspace",
        });
        const document = await context.client.createKnowledgeDrop(workspaceId, {
          fileId: asset.id,
          authorityKind: destination,
          agentAccess: true,
        });
        if (document.status === "failed")
          throw new Error(
            document.error || "The original is saved, but its text could not be prepared.",
          );
      }
      if (active.current)
        toast.success("Files uploaded", {
          description: "The files are saved and their text is being prepared for agents to read.",
        });
    } catch (reason) {
      if (active.current) setError(String(reason));
    } finally {
      if (active.current) {
        setUploading(false);
        setRefresh((value) => value + 1);
      }
      if (input.current) input.current.value = "";
    }
  }
  return (
    <>
      <div
        className="grid gap-6"
        role="region"
        aria-label="File upload drop zone"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          void upload(event.dataTransfer.files);
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">
              {scope === "organization" ? "Company reference material" : "File library"}
            </h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-fg-muted">
              {scope === "organization"
                ? "Documents and other source material available across your company."
                : "Files uploaded here or in chats. Open a file to read it and see what agents have learned from it."}
            </p>
          </div>
          {canUpload && (scope !== "organization" || canWriteOrganization) ? (
            <>
              <input
                ref={input}
                type="file"
                multiple
                className="hidden"
                aria-label="Files to retain"
                onChange={(event) => void upload(event.target.files)}
              />
              <Button disabled={uploading} onClick={() => input.current?.click()}>
                {uploading ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <UploadIcon className="size-4" />
                )}
                {uploading ? "Uploading…" : "Upload files"}
              </Button>
            </>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3">
          <Select
            className="w-auto min-w-40"
            aria-label="File and source scope"
            value={scope}
            disabled={uploading || Boolean(authorityKind)}
            onChange={(event) => {
              setScope(event.target.value as DocumentAuthorityKind);
              setSelectedFile(null);
            }}
          >
            <option value="workspace">Workspace files</option>
            <option value="personal">Only my files</option>
            {authorityKind === "organization" ? (
              <option value="organization">Company</option>
            ) : null}
          </Select>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh files"
            title="Refresh files"
            disabled={busy || uploading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-status-error">
            {error}
          </p>
        ) : null}
        {scope === "organization" ? (
          <KnowledgeBrowser
            key={`${scope}:${refresh}`}
            workspaceId={workspaceId}
            sourceOnly
            initialKind="source"
            initialScope="organization"
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {files.map((file) => (
                <KnowledgeCard
                  key={file.id}
                  title={file.filename}
                  variant="file"
                  icon={<FileTextIcon className="size-6" />}
                  metadata={
                    <>
                      <span>{formatBytes(file.sizeBytes)}</span>
                      <span>{file.scope === "personal" ? "Only me" : "Workspace"}</span>
                    </>
                  }
                  onClick={() => setSelectedFile(file)}
                />
              ))}
            </div>
            {busy && !files.length ? (
              <p role="status" className="text-sm text-fg-muted">
                Loading files…
              </p>
            ) : null}
            {!busy && !files.length && !error ? (
              <div className="grid place-items-center gap-3 rounded-xl border border-dashed border-border py-14 text-center">
                <UploadIcon className="size-7 text-fg-subtle" />
                <p className="text-sm font-medium">Keep your files here</p>
                <p className="max-w-sm px-5 text-sm leading-6 text-fg-muted">
                  {canUpload
                    ? "Drop files onto this page or use Upload files. Attachments from your chats appear here too."
                    : "Files shared with you will appear here."}
                </p>
              </div>
            ) : null}
            {cursor ? (
              <Button
                variant="outline"
                className="w-fit"
                disabled={busy}
                onClick={() => void more()}
              >
                {busy ? "Loading…" : "More files"}
              </Button>
            ) : null}
          </>
        )}
      </div>
      <Dialog
        open={Boolean(selectedFile)}
        onOpenChange={(open) => {
          if (!open) setSelectedFile(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{selectedFile?.filename ?? "File"}</DialogTitle>
            <DialogDescription>Original file and the text available to agents.</DialogDescription>
          </DialogHeader>
          {selectedFile ? (
            <>
              <Link
                to="/workspaces/$workspaceId/state"
                params={{ workspaceId }}
                search={{ file: selectedFile.id }}
                className="flex w-fit items-center gap-1.5 text-sm text-brand hover:underline"
              >
                View knowledge from this file <ArrowUpRightIcon className="size-4" />
              </Link>
              <Tabs key={selectedFile.id} defaultValue="preview">
                <TabsList aria-label="File details">
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                  <TabsTrigger value="text">Extracted text</TabsTrigger>
                </TabsList>
                <TabsContent value="preview" className="mt-3">
                  <OriginalFile workspaceId={workspaceId} file={selectedFile} />
                </TabsContent>
                <TabsContent value="text" className="mt-3">
                  <FileSourceText workspaceId={workspaceId} fileId={selectedFile.id} />
                </TabsContent>
              </Tabs>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function OriginalFile({ workspaceId, file }: { workspaceId: string; file: FileAsset }) {
  const { client } = useAppContext();
  const [url, setUrl] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void client
      .createFileDownloadUrl(workspaceId, file.id)
      .then((result) => {
        if (!["http:", "https:"].includes(new URL(result.url).protocol))
          throw new Error("Original file URL unavailable");
        if (current) setUrl(result.url);
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, file.id]);
  if (error) return <p role="alert">{error}</p>;
  if (!url) return <p role="status">Loading original…</p>;
  return (
    <div className="grid gap-3">
      {file.contentType === "application/pdf" ? (
        <object
          data={url}
          type="application/pdf"
          aria-label={`${file.filename} preview`}
          className="h-[65vh] w-full rounded-md border border-border"
        >
          <a href={url} target="_blank" rel="noreferrer">
            Open PDF
          </a>
        </object>
      ) : null}
      <a href={url} target="_blank" rel="noreferrer" className="text-sm underline">
        Open or download original
      </a>
    </div>
  );
}
