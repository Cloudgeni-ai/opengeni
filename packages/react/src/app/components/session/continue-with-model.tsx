import { CircleAlertIcon } from "lucide-react";
import { Button } from "../../../ui/button";
import { noteTurnFailureAction } from "../../lib/turn-failure-actions";

export type ContinueWithModel = {
  /** Readable name of the model the new chat uses. */
  label: string;
  pending?: boolean | undefined;
  onContinue: () => void;
};

/**
 * Continue in a new chat on another model. A chat frozen on Codex keeps its
 * model; the new chat starts with a summary of this one.
 */
export function ContinueWithModelButton({ label, pending = false, onContinue }: ContinueWithModel) {
  return (
    <Button
      type="button"
      size="sm"
      disabled={pending}
      data-testid="continue-with-model"
      title="Starts a new chat with a summary of this one"
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
 * Composer line while a chat that stays on Codex waits for Codex, for example
 * for its usage limit to reset. The timeline already says why it waits.
 */
export function CodexWaitNotice({ continueWith }: { continueWith: ContinueWithModel }) {
  return (
    <div
      role="status"
      data-testid="codex-wait-notice"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 pt-2.5 text-sm md:px-4"
    >
      <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-status-waiting" />
      <p className="min-w-0 flex-1 font-medium text-fg">
        Codex can&apos;t run this chat right now.
      </p>
      <ContinueWithModelButton {...continueWith} />
    </div>
  );
}
