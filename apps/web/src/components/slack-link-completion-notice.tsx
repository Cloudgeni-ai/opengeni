import { Button } from "@/components/ui/button";

export function SlackLinkCompletionNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-surface px-4 py-3 text-sm"
    >
      <div>
        <p className="font-medium">Your Slack identity is linked</p>
        <p className="text-fg-subtle">
          Return to Slack and send your message again. For a channel task, check your bot DMs for a
          workspace choice.
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
