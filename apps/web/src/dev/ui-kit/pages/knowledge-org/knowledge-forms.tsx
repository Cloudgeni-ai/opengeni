import { useId, useRef, useState, type ReactNode } from "react";
import { FileTextIcon, UploadIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FormDialog, FormPage } from "@/components/ui/form-dialog";
import { LogoTile } from "@/components/ui/logo-tile";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";

import {
  ENTRY_TYPES,
  KNOWLEDGE_WORKSPACE,
  TYPE_LABEL,
  type EntryType,
  type LibraryEntry,
} from "./knowledge-data";
import { wait, type PagePicks } from "./picks";

/* ----------------------------------------------------------------------------
   Create forms for the Knowledge page: Add knowledge (a page), and Upload
   files and New collection (small centered dialogs: one field each).
   -------------------------------------------------------------------------- */

/** A starter from the empty state. */
export interface KnowledgeTemplate {
  title: string;
  content: string;
  type?: NewEntry["type"];
}

export interface NewEntry {
  title: string;
  content: string;
  type: Exclude<EntryType, "general">;
  scope: "workspace" | "personal";
  collection: string | null;
}

const NO_COLLECTION = "none";

/**
 * Add knowledge: its own page ("← Knowledge"). Mount it only while it's
 * open. `onCreate` navigates to the new entry, so a successful submit
 * doesn't also call `onClose`.
 */
export function AddKnowledgeForm({
  onClose,
  picks,
  entries,
  collections,
  onCreate,
  prefill,
}: {
  onClose: () => void;
  picks: PagePicks;
  entries: LibraryEntry[];
  collections: string[];
  onCreate: (entry: NewEntry) => void;
  /** Starts the form from a template (the empty state's starter cards). */
  prefill?: KnowledgeTemplate | null;
}) {
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [content, setContent] = useState(prefill?.content ?? "");
  const [type, setType] = useState<NewEntry["type"]>(prefill?.type ?? "fact");
  const [scope, setScope] = useState<NewEntry["scope"]>("workspace");
  const [collection, setCollection] = useState<string>(NO_COLLECTION);
  const [errors, setErrors] = useState<{ title?: ReactNode; content?: ReactNode }>({});

  const submit = async () => {
    const trimmed = title.trim();
    const duplicate = entries.some(
      (entry) => entry.title.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
    );
    const next = {
      title: !trimmed
        ? "Add a title."
        : duplicate
          ? "There's already an entry with this title. Edit that one instead."
          : undefined,
      content: content.trim() ? undefined : "Add what agents should know.",
    };
    setErrors(next);
    if (next.title || next.content) return false;
    await wait(700);
    onCreate({
      title: trimmed,
      content: content.trim(),
      type,
      scope,
      collection: collection === NO_COLLECTION ? null : collection,
    });
    return true;
  };

  const fields = (
    <FieldStack>
      <Field label="Title" error={errors.title}>
        <TextInput
          value={title}
          placeholder="For example: Staging deploys run from the main branch"
          suppressAutofill
          onChange={(event) => {
            setTitle(event.target.value);
            setErrors((current) => ({ ...current, title: undefined }));
          }}
        />
      </Field>
      <Field
        label="What agents should know"
        hint="One fact or decision. Rules for how agents work belong in Instructions."
        error={errors.content}
      >
        <TextArea
          rows={4}
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setErrors((current) => ({ ...current, content: undefined }));
          }}
        />
      </Field>
      <Field
        label="Save to"
        group
        hint={
          scope === "workspace"
            ? `Agents in ${KNOWLEDGE_WORKSPACE.name} can use it.`
            : "Only your own chats can use it."
        }
      >
        <SegmentedControl<NewEntry["scope"]>
          aria-label="Save to"
          variant={picks.segmented}
          options={[
            { value: "workspace", label: "This workspace" },
            { value: "personal", label: "Only me" },
          ]}
          value={scope}
          onValueChange={setScope}
          className="self-start"
        />
      </Field>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field label="Type">
          <SelectMenu<NewEntry["type"]>
            variant={picks.select}
            size="md"
            options={ENTRY_TYPES.map((value) => ({ value, label: TYPE_LABEL[value] }))}
            value={type}
            onValueChange={setType}
            className="w-full"
            searchPlaceholder="Search types"
          />
        </Field>
        <Field label="Collection" optional>
          <SelectMenu
            variant={picks.select}
            size="md"
            options={[
              { value: NO_COLLECTION, label: "None" },
              ...collections.map((name) => ({ value: name, label: name })),
            ]}
            value={collection}
            onValueChange={setCollection}
            className="w-full"
            searchPlaceholder="Search collections"
          />
        </Field>
      </div>
    </FieldStack>
  );

  return (
    <FormPage
      title="Add knowledge"
      description="Something agents should look up when it's relevant."
      submitLabel="Add to Library"
      pendingLabel="Adding…"
      onSubmit={submit}
      back={{ label: "Knowledge", onClick: onClose }}
      onCancel={onClose}
      className="flex-1"
    >
      {fields}
    </FormPage>
  );
}

export function UploadFilesDialog({
  open,
  onOpenChange,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (names: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const add = (names: string[]) => {
    setFiles((current) => [...current, ...names.filter((name) => !current.includes(name))]);
    setError(null);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setFiles([]);
          setError(null);
        }
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
        await wait(900);
        onUpload(files);
        setFiles([]);
        return true;
      }}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div
          className={
            "flex min-w-0 flex-col items-center gap-3 rounded-[14px] border border-dashed px-6 py-8 text-center " +
            (error ? "border-danger" : "border-border-strong")
          }
        >
          <LogoTile icon={<UploadIcon />} tone="brand" />
          <div>
            <p className="text-sm font-medium text-fg">Drop files here</p>
            <p id={hintId} className="text-xs leading-4.5 text-fg-muted">
              PDF, Markdown, text and images, up to 25 MB each.
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
              add(Array.from(event.target.files ?? []).map((file) => file.name));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => add(["on-call-handbook.pdf", "eu-data-map.png"])}
            className="text-xs font-medium text-brand underline-offset-2 hover:underline pointer-coarse:min-h-11"
          >
            Use two sample files
          </button>
        </div>
        {error ? (
          <p role="alert" className="text-xs leading-4.5 text-danger">
            {error}
          </p>
        ) : null}
        {files.length > 0 ? (
          <ul aria-label="Files to upload" className="flex min-w-0 flex-col divide-y divide-border">
            {files.map((name) => (
              <li key={name} className="flex min-w-0 items-center gap-3 py-2.5">
                <LogoTile size="sm" icon={<FileTextIcon />} />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${name}`}
                  onClick={() => setFiles((current) => current.filter((each) => each !== name))}
                  className="shrink-0 text-fg-subtle hover:text-fg pointer-coarse:size-11"
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </FormDialog>
  );
}

export function NewCollectionDialog({
  open,
  onOpenChange,
  collections,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collections: string[];
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setName("");
          setError(null);
        }
      }}
      size="sm"
      title="New collection"
      description="A folder in the Library, for related entries like incidents or runbooks."
      submitLabel="Create collection"
      pendingLabel="Creating…"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setError("Name the collection.");
          return false;
        }
        if (collections.some((each) => each.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
          setError(`There's already a collection called ${trimmed}.`);
          return false;
        }
        await wait(500);
        onCreate(trimmed);
        setName("");
        return true;
      }}
    >
      <Field label="Name" error={error ?? undefined}>
        <TextInput
          value={name}
          placeholder="For example: Runbooks"
          suppressAutofill
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}
