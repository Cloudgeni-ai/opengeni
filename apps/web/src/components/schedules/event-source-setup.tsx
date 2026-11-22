/**
 * How a webhook source is connected, shared by the add flow and the source's
 * page: its URL to copy and how your own app signs its requests. An app's
 * pasted secret uses the shared `PastedWebhookSteps` (also in Add trigger).
 */
import { t } from "@opengeni/react/app/lib/console-text";
import { PastedWebhookSteps, pastedWebhookSetup } from "@opengeni/react/automations";
import { CopyField } from "@opengeni/react/ui/copy-field";
import { Field } from "@opengeni/react/ui/field";
import { InlineHelp } from "@opengeni/react/ui/inline-help";
import type { EventSource } from "@opengeni/sdk";

export function WebhookUrlField({ url, hint }: { url: string | null; hint?: string | undefined }) {
  return (
    <Field label="Webhook URL" hint={hint}>
      <CopyField variant="field" wrap value={url ?? ""} label="webhook URL" placeholder="No URL" />
    </Field>
  );
}

export function StandardWebhookHelp() {
  return (
    <InlineHelp icon>
      Send events as JSON POST requests to this URL, signed the{" "}
      <a
        href="https://www.standardwebhooks.com"
        target="_blank"
        rel="noreferrer"
        className="og-link"
      >
        Standard Webhooks
      </a>{" "}
      way with this secret. Most webhook libraries do this for you.
    </InlineHelp>
  );
}

/** The two steps in Linear, Sentry or another app, with the field for the secret it shows. */
export function SourcePastedWebhookSteps({
  source,
  secret,
  error,
  onSecretChange,
}: {
  source: Pick<EventSource, "kind" | "adapter" | "format" | "webhookUrl">;
  secret: string;
  error?: string | undefined;
  onSecretChange: (value: string) => void;
}) {
  const setup = pastedWebhookSetup(t, source);
  if (!setup) return null;
  return (
    <PastedWebhookSteps
      className="gap-6"
      url={source.webhookUrl}
      setup={setup}
      value={secret}
      onChange={onSecretChange}
      error={error}
    />
  );
}
