/**
 * "Ask about this meeting": one line at the bottom of the Summary and
 * Transcript tabs. The host answers it, usually by starting a chat with the
 * meeting attached; the input clears once the host has taken the question.
 */
import { useOpenGeniText } from "../messages/runtime";
import { useId, useState } from "react";
import { ArrowUpIcon, LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "../ui/button";
import { TextInput } from "../ui/field";

/** False when the host couldn't take the question and has already said why. */
export type MeetingAskResult = void | boolean;

export function MeetingAsk({
  onAsk,
}: {
  /**
   * Takes the question. Resolving false keeps it in the input (the host has
   * said why); a rejection keeps it and says the chat couldn't start.
   */
  onAsk: (question: string) => MeetingAskResult | Promise<MeetingAskResult>;
}) {
  const msg = useOpenGeniText();
  const id = useId();
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const trimmed = question.trim();
  const submit = async () => {
    if (!trimmed || asking) return;
    setAsking(true);
    try {
      if ((await onAsk(trimmed)) !== false) setQuestion("");
    } catch (error) {
      toast.error(msg("meetings.ask.couldNotAsk"), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setAsking(false);
    }
  };
  return (
    // Stays in reach at the bottom of the window while the tab scrolls.
    <form
      aria-label={msg("meetings.ask.placeholder")}
      className="sticky bottom-0 z-10 -mx-1 bg-bg px-1 pt-3 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="relative">
        <label htmlFor={id} className="sr-only">
          {msg("meetings.ask.placeholder")}
        </label>
        <TextInput
          id={id}
          value={question}
          maxLength={4000}
          autoComplete="off"
          disabled={asking}
          placeholder={msg("meetings.ask.placeholder")}
          onChange={(event) => setQuestion(event.target.value)}
          className="h-11 rounded-[14px]! pr-12 shadow-og-sm"
        />
        <Button
          type="submit"
          size="icon-sm"
          disabled={!trimmed || asking}
          aria-label={msg("meetings.ask.send")}
          className="absolute top-1/2 right-1.5 size-8 -translate-y-1/2 rounded-[10px] pointer-coarse:size-9"
        >
          {asking ? (
            <LoaderCircleIcon
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : (
            <ArrowUpIcon aria-hidden="true" />
          )}
        </Button>
      </div>
    </form>
  );
}
