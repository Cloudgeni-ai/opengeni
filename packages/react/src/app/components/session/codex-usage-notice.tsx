import { CircleAlertIcon, InfoIcon } from "lucide-react";
import { Button } from "../../../ui/button";
import { noteTurnFailureAction } from "../../lib/turn-failure-actions";

/** What the person can do while this chat's ChatGPT/Codex plan is out of usage. */
export type CodexUsageChoice = {
  /** Plain reset sentence, for example "Resets Sat 14:05." or "Reset time unknown.". */
  resetText: string;
  /** The chat already waits and continues on its own when the limit resets. */
  waiting?: boolean | undefined;
  pending?: boolean | undefined;
  /** Why the last action did not go through, in words. */
  error?: string | null | undefined;
  onWait: () => void;
  /** Opens the composer's model picker; picking a model continues this chat with it. */
  onSwitchModel: () => void;
};

/**
 * One plain line shown when the chosen model will rebuild a chat Codex
 * compacted, so the user knows earlier detail may be summarized away.
 */
export function ModelSwitchHeadsUp({ text, className }: { text: string; className?: string }) {
  return (
    <p
      data-testid="model-switch-heads-up"
      className={`flex min-w-0 items-start gap-1.5 text-xs text-fg-muted ${className ?? ""}`}
    >
      <InfoIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}

/** "Wait for reset" and "Switch model", for the composer notice and the failed-chat banner. */
export function CodexUsageActions({
  waiting = false,
  pending = false,
  onWait,
  onSwitchModel,
}: CodexUsageChoice) {
  return (
    <>
      {waiting ? (
        <span data-testid="codex-usage-waiting" className="text-xs text-fg-muted">
          Continues when it resets.
        </span>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending}
          data-testid="codex-usage-wait"
          onClick={() => {
            noteTurnFailureAction("retry");
            onWait();
          }}
        >
          Wait for reset
        </Button>
      )}
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={pending}
        data-testid="codex-usage-switch-model"
        onClick={() => {
          noteTurnFailureAction("switch_model");
          onSwitchModel();
        }}
      >
        Switch model
      </Button>
    </>
  );
}

/**
 * Composer line while this chat's ChatGPT/Codex plan is out of usage: when it
 * resets, and the two ways on. The timeline already says why it stopped.
 */
export function CodexUsageNotice({ choice }: { choice: CodexUsageChoice }) {
  return (
    <div
      role="status"
      data-testid="codex-usage-notice"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 pt-2.5 text-sm md:px-4"
    >
      <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-status-waiting" />
      <p className="min-w-0 flex-1 text-fg-muted">
        <span className="font-medium text-fg">Codex usage limit reached.</span> {choice.resetText}
      </p>
      <CodexUsageActions {...choice} />
      {choice.error ? (
        <p role="alert" className="basis-full text-xs text-fg-muted">
          {choice.error}
        </p>
      ) : null}
    </div>
  );
}
