/**
 * How a webhook source is connected, shared by the add flow and the source's
 * page: its URL to copy, the steps in Linear or Sentry with the secret to
 * paste back, and how your own app signs its requests.
 */
import { t } from "@opengeni/react/app/lib/console-text";
import { pastedWebhookSetup } from "@opengeni/react/automations";
import { CopyField } from "@opengeni/react/ui/copy-field";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
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

/** The two steps in Linear or Sentry, with the field for the secret it shows. */
export function PastedWebhookSteps({
  source,
  secret,
  error,
  onSecretChange,
}: {
  source: Pick<EventSource, "kind" | "adapter" | "webhookUrl">;
  secret: string;
  error?: string | undefined;
  onSecretChange: (value: string) => void;
}) {
  const setup = pastedWebhookSetup(t, source);
  if (!setup) return null;
  const label = setup.secretName.charAt(0).toUpperCase() + setup.secretName.slice(1);
  return (
    <FieldStack>
      <WebhookUrlField url={source.webhookUrl} hint={setup.urlStep} />
      <Field label={label} error={error} hint={setup.secretStep}>
        <TextInput
          type="password"
          mono
          value={secret}
          onChange={(event) => onSecretChange(event.target.value)}
          suppressAutofill
        />
      </Field>
    </FieldStack>
  );
}
