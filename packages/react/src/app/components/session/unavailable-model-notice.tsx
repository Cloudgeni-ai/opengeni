import { CircleAlertIcon } from "lucide-react";

/**
 * Composer line for a chat whose model was retired or removed from the
 * catalog. Earlier turns keep their model; only the next message changes, and
 * the line says which model it will use instead of switching silently.
 */
export function UnavailableModelNotice({
  modelName,
  replacementLabel,
}: {
  /** Readable name of the session's unavailable model. */
  modelName: string;
  /** The model the composer now has selected, or null when none is selected. */
  replacementLabel: string | null;
}) {
  return (
    <div
      role="status"
      data-testid="unavailable-model-notice"
      className="flex min-w-0 items-start gap-2 px-3.5 pt-2.5 text-sm md:px-4"
    >
      <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-status-waiting" />
      <p className="min-w-0 flex-1 text-fg-muted">
        <span className="font-medium text-fg">
          This chat&apos;s model ({modelName}) is no longer available.
        </span>{" "}
        {replacementLabel
          ? `Your next message will use ${replacementLabel}.`
          : "Select a different model to continue."}
      </p>
    </div>
  );
}
