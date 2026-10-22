import { CopyField } from "@opengeni/react/ui/copy-field";

export function ClaudeTokenInstructions() {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-sm leading-5 text-fg-muted">
        Run this in a terminal where you use Claude Code, then paste the token below.
      </p>
      <CopyField value="claude setup-token" label="Create a Claude setup token" variant="field" />
      <p className="m-0 text-xs leading-4.5 text-fg-muted">
        Setup tokens cannot check current usage or renew automatically. Replace them when they
        expire or are revoked.
      </p>
    </div>
  );
}

export const CLAUDE_MODEL_CHOICES = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
] as const;
export function claudeModelLabel(id: string) {
  return CLAUDE_MODEL_CHOICES.find((model) => model.id === id)?.label ?? id;
}
