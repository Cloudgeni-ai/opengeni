import type { KnowledgeEntryScope } from "@opengeni/sdk";
import { FileTextIcon, UploadIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { LogoTile } from "@/components/ui/logo-tile";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAppContext } from "@/context";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

import { errorText } from "./knowledge-data";

/* ----------------------------------------------------------------------------
   Upload files: a centered prompt with a drop zone. Each file is saved as its
   original first, then becomes a File entry in the Library; text preparation
   and search indexing continue in the background.
   -------------------------------------------------------------------------- */

type UploadClient = Pick<
  ReturnType<typeof useAppContext>["client"],
  "uploadFile" | "createKnowledgeDrop"
>;

/**
 * Saves each original first (private when it goes to Only me), then asks for
 * its text to be prepared as a File entry. `onSaved` reports how many
 * originals are durable, so a failure part-way can say what was kept.
 */
export async function uploadToKnowledge(
  client: UploadClient,
  workspaceId: string,
  files: File[],
  scope: KnowledgeEntryScope,
  onSaved: (count: number) => void = () => undefined,
): Promise<void> {
  let saved = 0;
  for (const file of files) {
    const asset = await client.uploadFile(workspaceId, {
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      data: file,
      scope: scope === "personal" ? "personal" : "workspace",
    });
    saved += 1;
    onSaved(saved);
    const document = await client.createKnowledgeDrop(workspaceId, {
      fileId: asset.id,
      authorityKind: scope,
      agentAccess: true,
    });
    if (document.status === "failed")
      throw new Error(
        document.error || `${file.name} is saved, but its text couldn't be prepared for agents.`,
      );
  }
}

export function UploadFilesDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  personal,
  canWriteOrganization,
  defaultScope,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  personal: boolean;
  canWriteOrganization: boolean;
  defaultScope: KnowledgeEntryScope;
  onUploaded: () => void;
}) {
  const { client } = useAppContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [scope, setScope] = useState<KnowledgeEntryScope>(defaultScope);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const scopes: KnowledgeEntryScope[] = personal
    ? ["personal"]
    : ["workspace", "personal", ...(canWriteOrganization ? (["organization"] as const) : [])];

  const add = (list: FileList | null) => {
    const next = Array.from(list ?? []);
    setFiles((current) => [
      ...current,
      ...next.filter(
        (file) => !current.some((each) => each.name === file.name && each.size === file.size),
      ),
    ]);
    setError(null);
  };

  const reset = () => {
    setFiles([]);
    setError(null);
    setScope(defaultScope);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title="Upload files"
      description="Agents read them when they're relevant, like any other knowledge."
      submitLabel={files.length > 1 ? `Upload ${files.length} files` : "Upload"}
      pendingLabel="Uploading…"
      onSubmit={async () => {
        if (files.length === 0) {
          setError("Choose at least one file.");
          return false;
        }
        let saved = 0;
        try {
          await uploadToKnowledge(client, workspaceId, files, scope, (count) => {
            saved = count;
          });
        } catch (reason) {
          onUploaded();
          setFiles((current) => current.slice(saved));
          throw new Error(
            saved > 0
              ? `Uploaded ${saved} of ${files.length}. ${errorText(reason)}`
              : errorText(reason),
            { cause: reason },
          );
        }
        toast(
          files.length === 1 ? `Uploaded ${files[0]!.name}` : `Uploaded ${files.length} files`,
          {
            description: "Agents can use them once their text is ready. That can take a minute.",
          },
        );
        onUploaded();
        reset();
        return true;
      }}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <div
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            add(event.dataTransfer.files);
          }}
          className={cn(
            "flex min-w-0 flex-col items-center gap-3 rounded-[14px] border border-dashed px-6 py-7 text-center transition-colors duration-[120ms]",
            error ? "border-danger" : dragging ? "border-brand bg-brand/5" : "border-border-strong",
          )}
        >
          <LogoTile icon={<UploadIcon />} />
          <div>
            <p className="text-sm font-medium text-fg">Drop files here</p>
            <p id={hintId} className="text-xs leading-4.5 text-fg-muted">
              PDFs, documents, text and images.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-describedby={hintId}
            onClick={() => inputRef.current?.click()}
            className="pointer-coarse:h-11"
          >
            Choose files
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              add(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
        {error ? (
          <p role="alert" className="text-xs leading-4.5 text-danger">
            {error}
          </p>
        ) : null}
        {files.length > 0 ? (
          <ul aria-label="Files to upload" className="flex min-w-0 flex-col divide-y divide-border">
            {files.map((file) => (
              <li
                key={`${file.name}:${file.size}`}
                className="flex min-w-0 items-center gap-3 py-2"
              >
                <LogoTile size="sm" icon={<FileTextIcon />} />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{file.name}</span>
                <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                  {formatBytes(file.size)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles((current) => current.filter((each) => each !== file))}
                  className="shrink-0 text-fg-subtle hover:text-fg pointer-coarse:size-11"
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {scopes.length > 1 ? (
          <Field
            label="Save to"
            group
            hint={
              scope === "workspace"
                ? `Agents in ${workspaceName} can use them.`
                : scope === "organization"
                  ? "Agents in every workspace of your organization can use them."
                  : "Only your own chats can use them."
            }
          >
            <SegmentedControl<KnowledgeEntryScope>
              aria-label="Save to"
              options={scopes.map((value) => ({
                value,
                label:
                  value === "workspace"
                    ? "This workspace"
                    : value === "personal"
                      ? "Only me"
                      : "Organization",
              }))}
              value={scope}
              onValueChange={setScope}
              className="self-start"
            />
          </Field>
        ) : null}
      </div>
    </FormDialog>
  );
}
