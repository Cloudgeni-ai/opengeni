import { CheckIcon, Loader2Icon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { RepositoryRefInput } from "@/components/repository-ref-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import type { RepoDraft } from "@/lib/session-tools";

export type ManualRepositoryAttachResult = { warning?: string } | void;

export function ManualRepositoryEditor(props: {
  repository: RepoDraft;
  mounted: boolean;
  pending: boolean;
  onUpdate: (patch: Partial<RepoDraft>) => void;
  onRemove: () => void;
  onAttach: (repository: RepoDraft) => Promise<ManualRepositoryAttachResult>;
}) {
  const [editing, setEditing] = useState(props.repository.attached === false);
  const [url, setUrl] = useState(props.repository.url);
  const [ref, setRef] = useState(props.repository.ref);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (editing) return;
    setUrl(props.repository.url);
    setRef(props.repository.ref);
  }, [editing, props.repository.ref, props.repository.url]);

  useEffect(() => {
    if (props.repository.attached === true) setEditing(false);
  }, [props.repository.attached]);

  function updateDraft(patch: Partial<RepoDraft>): void {
    if (props.repository.attached === false) props.onUpdate({ ...patch, attached: false });
  }

  async function attach(): Promise<void> {
    if (checking || props.pending || props.mounted) return;
    setChecking(true);
    setError(null);
    setWarning(null);
    try {
      const result = await props.onAttach({
        ...props.repository,
        url,
        ref,
        attached: false,
      });
      setWarning(result?.warning ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  }

  if (props.mounted || (props.repository.attached === true && !editing)) {
    return (
      <div className="space-y-1.5 rounded-lg border border-border bg-bg/25 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-fg">{props.repository.url}</div>
            <div className="truncate text-2xs text-fg-subtle">Ref {props.repository.ref}</div>
          </div>
          {props.mounted ? (
            <MetaChip dot="idle" rounded="full">
              Mounted
            </MetaChip>
          ) : (
            <MetaChip dot="running" rounded="full">
              Attached
            </MetaChip>
          )}
        </div>
        {!props.mounted ? (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setEditing(true);
                setError(null);
                setWarning(null);
              }}
              disabled={props.pending}
            >
              <PencilIcon className="size-3" /> Edit
            </Button>
            {confirmRemove ? (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  onClick={props.onRemove}
                  disabled={props.pending}
                >
                  Remove
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setConfirmRemove(false)}
                  disabled={props.pending}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setConfirmRemove(true)}
                disabled={props.pending}
              >
                <Trash2Icon className="size-3" /> Remove
              </Button>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="space-y-2 rounded-lg border border-border bg-bg/25 p-2.5"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void attach();
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(7rem,0.42fr)]">
        <Input
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
            updateDraft({ url: event.target.value });
          }}
          disabled={props.pending || checking}
          placeholder="https://github.com/org/repo"
          aria-label="Repository URL"
          className="h-8 text-xs"
        />
        <RepositoryRefInput
          value={ref}
          defaultRef="branch, tag, or SHA"
          label="Repository ref"
          disabled={props.pending || checking}
          onChange={(value) => {
            setRef(value);
            setError(null);
            updateDraft({ ref: value });
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          onClick={() => void attach()}
          disabled={props.pending || checking}
        >
          {checking ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <CheckIcon className="size-3" />
          )}
          {checking ? "Checking" : "Attach"}
        </Button>
        {props.repository.attached === true ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setEditing(false);
              setUrl(props.repository.url);
              setRef(props.repository.ref);
              setError(null);
            }}
          >
            <XIcon className="size-3" /> Cancel edit
          </Button>
        ) : null}
        {confirmRemove ? (
          <>
            <Button
              type="button"
              variant="destructive"
              size="xs"
              onClick={props.onRemove}
              disabled={props.pending || checking}
            >
              Remove
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setConfirmRemove(false)}
              disabled={props.pending || checking}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setConfirmRemove(true)}
            disabled={props.pending || checking}
          >
            <Trash2Icon className="size-3" /> Remove
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-xs leading-5 text-status-failed" role="alert">
          {error}
        </p>
      ) : warning ? (
        <p className="text-xs leading-5 text-status-waiting">{warning}</p>
      ) : null}
    </div>
  );
}
