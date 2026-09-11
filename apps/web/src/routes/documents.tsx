import type { FileAsset } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import { FileTextIcon, Loader2Icon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common";
import { KnowledgeBrowser } from "@/components/knowledge/knowledge-browser";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

/** The legacy /documents URL now presents actual originals and canonical source content. */
export function DocumentsRoute({
  workspaceId,
  authorityKind,
}: {
  workspaceId: string;
  authorityKind?: DocumentAuthorityKind;
  returnToBrain?: boolean;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((item) => item.id === workspaceId) ?? null;
  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  const [scope, setScope] = useState<DocumentAuthorityKind>(
    authorityKind ?? (personal ? "personal" : "workspace"),
  );
  const [tab, setTab] = useState(authorityKind === "organization" ? "sources" : "files");
  const [files, setFiles] = useState<FileAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selectedFile, setSelectedFile] = useState<FileAsset | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [addingText, setAddingText] = useState(false);
  const [textTitle, setTextTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [savingText, setSavingText] = useState(false);
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
        toast.success("Original files saved", {
          description:
            "Searchable source content is being prepared. Agents retain useful findings during their work.",
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
  async function retainText() {
    if (
      savingText ||
      !sourceText.trim() ||
      !canManageKnowledge ||
      (scope === "organization" && !canWriteOrganization)
    )
      return;
    setSavingText(true);
    setError(null);
    try {
      await context.client.saveKnowledgeEntry(workspaceId, {
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        expectedVersion: 0,
        scope,
        entry: {
          kind: "source",
          title: textTitle.trim() || "Saved text",
          content: sourceText,
          source: { kind: "manual", retention: "full_text" },
        },
      });
      if (active.current) {
        setAddingText(false);
        setTextTitle("");
        setSourceText("");
        setTab("sources");
        setRefresh((value) => value + 1);
      }
    } catch (reason) {
      if (active.current) setError(String(reason));
    } finally {
      if (active.current) setSavingText(false);
    }
  }
  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<FileTextIcon className="size-4" />}
        title="Files & sources"
        description="Original files and the source content retained in Knowledge."
      />
      <div
        className="mt-6 grid gap-5"
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
        <div className="flex flex-wrap items-center gap-3">
          <Select
            aria-label="File and source scope"
            value={scope}
            disabled={uploading || Boolean(authorityKind)}
            onChange={(event) => {
              const next = event.target.value as DocumentAuthorityKind;
              setScope(next);
              setSelectedFile(null);
              if (next === "organization") setTab("sources");
            }}
          >
            <option value="workspace">Workspace</option>
            <option value="personal">Only me</option>
            <option value="organization">Company</option>
          </Select>
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
          {canManageKnowledge && (scope !== "organization" || canWriteOrganization) ? (
            <Button variant="outline" disabled={uploading} onClick={() => setAddingText(true)}>
              Add text
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={busy || uploading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh
          </Button>
          <Link
            to="/workspaces/$workspaceId/state"
            params={{ workspaceId }}
            search={{}}
            className="text-sm text-fg-muted hover:text-fg"
          >
            Agent Knowledge
          </Link>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-status-error">
            {error}
          </p>
        ) : null}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="files" disabled={scope === "organization"}>
              Files
            </TabsTrigger>
            <TabsTrigger value="sources">Source content</TabsTrigger>
          </TabsList>
          <TabsContent value="files" className="mt-4 grid gap-3">
            {busy && !files.length ? (
              <p role="status">Loading files…</p>
            ) : !files.length ? (
              <p className="text-sm text-fg-muted">
                No retained files in this scope yet. Files uploaded in chats appear here too.
              </p>
            ) : null}
            {files.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-4 rounded-lg border border-border p-4"
              >
                <FileTextIcon className="size-5 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <button
                    className="break-words text-left text-sm font-medium hover:underline"
                    onClick={() => setSelectedFile(file)}
                  >
                    {file.filename}
                  </button>
                  <p className="mt-1 text-xs text-fg-muted">
                    Original copy · {formatBytes(file.sizeBytes)} ·{" "}
                    {file.scope === "personal" ? "Only me" : "Workspace"}
                  </p>
                </div>
                <Link
                  to="/workspaces/$workspaceId/state"
                  params={{ workspaceId }}
                  search={{ file: file.id }}
                  className="text-sm text-fg-muted hover:text-fg"
                >
                  Related knowledge
                </Link>
                <Button variant="outline" size="sm" onClick={() => setSelectedFile(file)}>
                  Open
                </Button>
              </div>
            ))}
            {cursor ? (
              <Button variant="outline" disabled={busy} onClick={() => void more()}>
                {busy ? "Loading…" : "More files"}
              </Button>
            ) : null}
          </TabsContent>
          <TabsContent value="sources" className="mt-4">
            <KnowledgeBrowser
              key={`${scope}:${refresh}`}
              workspaceId={workspaceId}
              personal={personal}
              sourceOnly
              initialKind="source"
              initialScope={scope === "personal" ? "personal" : scope}
            />
          </TabsContent>
        </Tabs>
      </div>
      <Dialog
        open={addingText}
        onOpenChange={(open) => {
          if (!savingText) setAddingText(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add source text</DialogTitle>
            <DialogDescription>
              Retains the text in{" "}
              {scope === "personal"
                ? "your personal Knowledge"
                : scope === "organization"
                  ? "company Knowledge"
                  : "workspace Knowledge"}
              . No file copy is created.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 text-sm">
            Title
            <Input value={textTitle} onChange={(event) => setTextTitle(event.target.value)} />
          </label>
          <label className="grid gap-2 text-sm">
            Source text
            <Textarea
              value={sourceText}
              onChange={(event) => setSourceText(event.target.value)}
              rows={10}
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-status-error">
              {error}
            </p>
          ) : null}
          <Button disabled={savingText || !sourceText.trim()} onClick={() => void retainText()}>
            {savingText ? "Saving…" : "Save source text"}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(selectedFile)}
        onOpenChange={(open) => {
          if (!open) setSelectedFile(null);
        }}
      >
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{selectedFile?.filename ?? "Original file"}</DialogTitle>
            <DialogDescription>The retained original copy.</DialogDescription>
          </DialogHeader>
          {selectedFile ? (
            <OriginalFile key={selectedFile.id} workspaceId={workspaceId} file={selectedFile} />
          ) : null}
        </DialogContent>
      </Dialog>
    </ContentPage>
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
