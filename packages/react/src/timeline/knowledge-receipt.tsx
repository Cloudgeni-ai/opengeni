import { createContext, useContext, useState, type ReactNode } from "react";
import { BrainCircuitIcon } from "lucide-react";
import { ActivityDisclosure, BodyNote } from "./shared";

export type KnowledgeActivityActions = {
  onInspect?: ((entryId: string) => void) | undefined;
  onRetryFile?: ((fileId: string) => Promise<boolean | void>) | undefined;
  retryDisabled?: boolean | undefined;
};
const KnowledgeActions = createContext<KnowledgeActivityActions>({});
export function KnowledgeActivityProvider({
  children,
  ...actions
}: KnowledgeActivityActions & { children: ReactNode }) {
  return <KnowledgeActions.Provider value={actions}>{children}</KnowledgeActions.Provider>;
}

/** A saved/pending result never opens or blocks the human-input surface. */
export function KnowledgeReceiptRow(props: {
  outcome: "published" | "pending" | "rejected" | "archived" | "failed";
  entryId?: string | undefined;
  fileId?: string | undefined;
  title?: string | undefined;
  source?: boolean | undefined;
}) {
  const actions = useContext(KnowledgeActions);
  const [retrying, setRetrying] = useState(false);
  const [retrySent, setRetrySent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label =
    props.outcome === "pending"
      ? "Knowledge saved for review"
      : props.outcome === "failed"
        ? "Source preparation failed"
        : props.outcome === "rejected"
          ? "Source remains rejected"
          : props.outcome === "archived"
            ? "Knowledge archived"
            : props.source
              ? "Source saved to Knowledge"
              : "Saved to Knowledge";
  const actionClass =
    "rounded-og-sm px-1 py-0.5 text-og-sm text-og-fg-muted hover:text-og-fg focus-visible:outline-2 focus-visible:outline-og-accent disabled:opacity-50";
  return (
    <ActivityDisclosure
      icon={<BrainCircuitIcon className="size-3.5" />}
      iconTone="muted"
      title={label}
      preview={props.title}
    >
      {props.outcome === "pending" ? (
        <BodyNote>
          Saved in Needs review. This task continues; future tasks can use it after approval.
        </BodyNote>
      ) : null}
      {props.outcome === "failed" ? (
        <BodyNote>
          The original file remains attached. Searchable text has not been retained.
        </BodyNote>
      ) : null}
      {props.outcome === "rejected" ? (
        <BodyNote>Processing the file again leaves the review decision unchanged.</BodyNote>
      ) : null}
      {props.entryId && actions.onInspect ? (
        <button
          className={actionClass}
          type="button"
          onClick={() => actions.onInspect?.(props.entryId!)}
        >
          {props.outcome === "pending" ? "Review in Knowledge" : "View in Knowledge"}
        </button>
      ) : null}
      {props.outcome === "failed" && props.fileId && actions.onRetryFile ? (
        <button
          className={actionClass}
          type="button"
          disabled={retrying || retrySent || actions.retryDisabled}
          onClick={() => {
            setRetrying(true);
            setError(null);
            void actions.onRetryFile!(props.fileId!)
              .then((sent) => {
                if (sent !== false) setRetrySent(true);
                else setError("Could not start the retry. Try again when the chat is ready.");
              })
              .catch(() => setError("Could not start the retry. Please try again."))
              .finally(() => setRetrying(false));
          }}
        >
          {retrying ? "Starting retry…" : retrySent ? "Retry requested" : "Retry preparation"}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="text-og-sm">
          {error}
        </p>
      ) : null}
    </ActivityDisclosure>
  );
}
