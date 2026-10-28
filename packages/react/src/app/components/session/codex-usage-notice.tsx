import { CircleAlertIcon, InfoIcon } from "lucide-react";
import { useId } from "react";
import { Switch } from "../../../ui/switch";

/** This chat's ChatGPT/Codex plan is out of usage: when it resets, and whether the chat goes on then. */
export type CodexUsageChoice = {
  /** Plain reset sentence, for example "Resets Sat 14:05." or "Reset time unknown.". */
  resetText: string;
  /** The chat waits for the limit and continues on its own when it resets. */
  continueAtReset: boolean;
  pending?: boolean | undefined;
  /** Why the last change did not go through, in words. */
  error?: string | null | undefined;
  /** Off pauses the waiting chat, so it waits for the person; on lets it continue at the reset. */
  onContinueAtResetChange: (continueAtReset: boolean) => void;
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

/** The "Continue at reset" switch, for the composer notice and the failed-chat banner. */
export function ContinueAtResetSwitch({
  continueAtReset,
  pending = false,
  onContinueAtResetChange,
}: CodexUsageChoice) {
  const id = useId();
  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-xs text-fg-muted">
      <label htmlFor={id} className="cursor-pointer select-none">
        Continue at reset
      </label>
      <Switch
        id={id}
        size="sm"
        checked={continueAtReset}
        pending={pending}
        onCheckedChange={onContinueAtResetChange}
        data-testid="codex-usage-continue-at-reset"
      />
    </span>
  );
}

/**
 * Composer line while this chat's ChatGPT/Codex plan is out of usage: when it
 * resets, and whether the chat continues then. Another model from the picker
 * continues the chat at once. The timeline already says why it stopped.
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
      <ContinueAtResetSwitch {...choice} />
      {choice.error ? (
        <p role="alert" className="basis-full text-xs text-fg-muted">
          {choice.error}
        </p>
      ) : null}
    </div>
  );
}
