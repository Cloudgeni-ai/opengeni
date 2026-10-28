import { CircleAlertIcon } from "lucide-react";
import { Button } from "../../../ui/button";
import { noteTurnFailureAction } from "../../lib/turn-failure-actions";

export type ContinueWithModel = {
  /** Readable name of the model the chat continues with. */
  label: string;
  pending?: boolean | undefined;
  /** Why the last attempt did not go through, in words. */
  error?: string | null | undefined;
  onContinue: () => void;
};

/** Switch this chat to another model and continue the blocked work with it. */
export function ContinueWithModelButton({ label, pending = false, onContinue }: ContinueWithModel) {
  return (
    <Button
      type="button"
      size="sm"
      disabled={pending}
      data-testid="continue-with-model"
      onClick={() => {
        noteTurnFailureAction("switch_model");
        onContinue();
      }}
    >
      Continue with {label}
    </Button>
  );
}

/**
 * Composer line while this chat's ChatGPT/Codex plan is out of usage, for
 * example while its turn waits for the limit to reset. The timeline already
 * says why it stopped.
 */
export function CodexUsageNotice({ continueWith }: { continueWith: ContinueWithModel }) {
  return (
    <div
      role="status"
      data-testid="codex-usage-notice"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 pt-2.5 text-sm md:px-4"
    >
      <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-status-waiting" />
      <p className="min-w-0 flex-1 font-medium text-fg">Codex usage limit reached.</p>
      <ContinueWithModelButton {...continueWith} />
      {continueWith.error ? (
        <p role="alert" className="basis-full text-fg-muted">
          {continueWith.error}
        </p>
      ) : null}
    </div>
  );
}
