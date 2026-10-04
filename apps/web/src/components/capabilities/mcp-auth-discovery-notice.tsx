import { Button } from "@/components/ui/button";

export function McpAuthDiscoveryNotice({
  checking,
  message,
  onRetry,
}: {
  checking: boolean;
  message?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="space-y-3">
      <p role="status" className="m-0 text-sm leading-5 text-fg-muted">
        {checking
          ? "Checking how to sign in…"
          : (message ??
            (onRetry
              ? "Could not determine how to sign in. Retry or check the provider's setup instructions."
              : "Setup required. Check the provider's instructions."))}
      </p>
      {!checking && onRetry ? (
        <Button type="button" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
