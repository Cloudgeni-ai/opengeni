import { CopyField } from "@/components/ui/copy-field";

export function ClaudeTokenInstructions() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">
        In a terminal on the computer where you use Claude Code, run this command and follow the
        sign-in instructions. Copy the token it gives you.
      </p>
      <CopyField value="claude setup-token" label="Create a Claude setup token" variant="field" />
      <p className="text-xs text-fg-muted">
        Setup tokens allow model calls but cannot check current usage. Use browser sign-in for usage
        checks and automatic token renewal. Replace setup tokens when they expire or are revoked.
      </p>
    </div>
  );
}

export const CLAUDE_MODEL_CHOICES = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
] as const;
export function claudeModelLabel(id: string) {
  return CLAUDE_MODEL_CHOICES.find((model) => model.id === id)?.label ?? id;
}
