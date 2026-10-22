import { createContext, useContext, useState, type ReactNode } from "react";
import { BrainCircuitIcon } from "lucide-react";
import { ActivityDisclosure, BodyNote } from "./shared";
import { useOpenGeniText } from "../messages/runtime";

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
  const t = useOpenGeniText();
  const actions = useContext(KnowledgeActions);
  const [retrying, setRetrying] = useState(false);
  const [retrySent, setRetrySent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label =
    props.outcome === "pending"
      ? t("timeline.knowledgeReceipt.knowledgeSavedForReview")
      : props.outcome === "failed"
        ? t("timeline.knowledgeReceipt.sourcePreparationFailed")
        : props.outcome === "rejected"
          ? t("timeline.knowledgeReceipt.sourceRemainsRejected")
          : props.outcome === "archived"
            ? t("timeline.knowledgeReceipt.knowledgeArchived")
            : props.source
              ? t("timeline.knowledgeReceipt.sourceSavedToKnowledge")
              : t("timeline.knowledgeReceipt.savedToKnowledge");
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
        <BodyNote>{t("timeline.knowledgeReceipt.savedInNeedsReviewThis")}</BodyNote>
      ) : null}
      {props.outcome === "failed" ? (
        <BodyNote>{t("timeline.knowledgeReceipt.theOriginalFileRemainsAttached")}</BodyNote>
      ) : null}
      {props.outcome === "rejected" ? (
        <BodyNote>{t("timeline.knowledgeReceipt.processingTheFileAgainLeaves")}</BodyNote>
      ) : null}
      {props.entryId && actions.onInspect ? (
        <button
          className={actionClass}
          type="button"
          onClick={() => actions.onInspect?.(props.entryId!)}
        >
          {props.outcome === "pending"
            ? t("timeline.knowledgeReceipt.reviewInKnowledge")
            : t("timeline.knowledgeReceipt.viewInKnowledge")}
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
                else setError(t("timeline.knowledgeReceipt.couldNotStartTheRetry"));
              })
              .catch(() => setError(t("timeline.knowledgeReceipt.couldNotStartTheRetry2")))
              .finally(() => setRetrying(false));
          }}
        >
          {retrying
            ? t("timeline.knowledgeReceipt.startingRetry")
            : retrySent
              ? t("timeline.knowledgeReceipt.retryRequested")
              : t("timeline.knowledgeReceipt.retryPreparation")}
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
