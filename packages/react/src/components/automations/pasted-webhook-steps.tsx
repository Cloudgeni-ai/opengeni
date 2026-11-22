/**
 * Connecting a Linear, Sentry or other app's webhook, shared by Add a source,
 * a source's page and an agent's Add trigger: the URL to paste into the app,
 * and one field for the secret the app then shows. The value goes only to the
 * server, which keeps it encrypted and never returns it.
 */
import type { ReactNode, RefObject } from "react";

import { cn } from "../../lib/cn";
import { CopyField } from "../../ui/copy-field";
import { Field, TextInput } from "../../ui/field";
import type { PastedWebhookSetup } from "./event-source-model";

export interface PastedWebhookStepsProps {
  /** The source's webhook URL. */
  url: string | null;
  setup: PastedWebhookSetup;
  /** The source's logo, beside its URL. */
  tile?: ReactNode;
  /** Controlled value; leave it out to read the field through `inputRef`. */
  value?: string | undefined;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null> | undefined;
  error?: string | undefined;
  autoFocus?: boolean | undefined;
  /** While replacing a secret that is set: keep it instead. */
  onKeep?: (() => void) | undefined;
  /** A page's wider field spacing, "gap-6"; a dialog keeps the default. */
  className?: string | undefined;
}

export function PastedWebhookSteps({
  url,
  setup,
  tile,
  value,
  onChange,
  inputRef,
  error,
  autoFocus,
  onKeep,
  className,
}: PastedWebhookStepsProps) {
  const label = setup.secretName.charAt(0).toUpperCase() + setup.secretName.slice(1);
  const copy = (
    <CopyField
      variant="field"
      wrap={!tile}
      value={url ?? ""}
      label="webhook URL"
      placeholder="No URL"
    />
  );
  return (
    <div data-pasted-webhook-steps="" className={cn("flex min-w-0 flex-col gap-3", className)}>
      <Field label="Webhook URL" hint={setup.urlStep}>
        {tile ? (
          <div className="flex min-w-0 items-center gap-2">
            {tile}
            <div className="min-w-0 flex-1">{copy}</div>
          </div>
        ) : (
          copy
        )}
      </Field>
      <Field label={label} hint={setup.secretStep} error={error}>
        <TextInput
          ref={inputRef}
          type="password"
          mono
          {...(value === undefined ? { defaultValue: "" } : { value })}
          onChange={(event) => onChange(event.target.value)}
          suppressAutofill
          autoFocus={autoFocus}
        />
      </Field>
      {onKeep ? (
        <div>
          <button type="button" className="og-link text-xs" onClick={onKeep}>
            Keep current {setup.secretName}
          </button>
        </div>
      ) : null}
    </div>
  );
}
