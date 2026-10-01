import type { IntegrationEndpointTestResult } from "@opengeni/sdk";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Disclosure } from "@/components/ui/disclosure";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";

import { untilLabel } from "./shared";

export const DEVELOPER_GUIDE_URL = "https://docs.opengeni.ai/guides/webhooks-and-credentials";
export const WEBHOOKS_GUIDE_URL = `${DEVELOPER_GUIDE_URL}#webhooks`;
export const CREDENTIAL_PROVIDER_GUIDE_URL = `${DEVELOPER_GUIDE_URL}#credential-provider`;

/** A block of code or JSON with Copy, the same look as the organization's quick start. */
export function CodeSample({
  code,
  label,
  className,
}: {
  code: string;
  /** What it is, for the copy button and the region: "Example request". */
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 className="text-xs leading-4.5 font-medium text-fg">{label}</h3>
        <RowButton
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
            } catch {
              toast.error("Couldn't copy it", { description: "Select it and copy it by hand." });
            }
          }}
        >
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </RowButton>
      </div>
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-80 max-w-full overflow-auto overscroll-contain rounded-[14px] border border-border bg-surface p-4 text-xs leading-[18px] text-fg"
      >
        <code translate="no" className="font-mono">
          {code}
        </code>
      </pre>
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function expiryLine(expiresAt: string | null): ReactNode {
  if (!expiresAt) return "No expiry given, so Opengeni renews them every 30 minutes.";
  return <>They expire {untilLabel(expiresAt)}, and Opengeni renews them 5 minutes before.</>;
}

/** What a run would get, by name only. */
function CredentialList({
  credentials,
}: {
  credentials: NonNullable<IntegrationEndpointTestResult["credentials"]>;
}) {
  const groups: Array<{ label: string; items: string[] }> = [
    {
      label: plural(credentials.environment.length, "environment variable"),
      items: credentials.environment,
    },
    { label: plural(credentials.files.length, "file"), items: credentials.files },
    { label: `Git access`, items: credentials.git },
    { label: plural(credentials.mcp.length, "MCP server"), items: credentials.mcp },
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0) {
    return (
      <p className="m-0">It answered ok with nothing in it, so runs would get no credentials.</p>
    );
  }
  return (
    <dl className="m-0 mt-1 grid min-w-0 gap-1.5">
      {groups.map((group) => (
        <div key={group.label} className="min-w-0">
          <dt className="text-xs leading-4.5 text-fg-muted">{group.label}</dt>
          <dd className="m-0 font-mono text-xs leading-4.5 break-words text-fg">
            {group.items.join(", ")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The answer to "does it work?": what happened in one line, what a run would
 * get (for a provider), and the exact request and response behind a
 * disclosure.
 */
export function EndpointTestResult({
  kind,
  result,
  testedAt,
  onDismiss,
}: {
  kind: "webhook" | "credential-provider";
  result: IntegrationEndpointTestResult;
  testedAt: Date;
  onDismiss?: () => void;
}) {
  const credentials = result.credentials;
  const timing = result.status ? `HTTP ${result.status}` : null;
  let tone: "success" | "waiting" | "failed";
  let title: string;
  let body: ReactNode;
  if (!result.ok) {
    tone = "failed";
    title = kind === "webhook" ? "Test event not delivered" : "Test failed";
    body = <p className="m-0">{result.error}</p>;
  } else if (kind === "webhook") {
    tone = "success";
    title = "Test event delivered";
    body = <p className="m-0">Your endpoint answered {timing}.</p>;
  } else if (credentials?.status === "not_applicable") {
    tone = "waiting";
    title = "Reached, but it gave no credentials";
    body = (
      <p className="m-0">
        Your endpoint answered <code className="font-mono text-xs">not_applicable</code>, so runs in
        this workspace would start without credentials from it.
      </p>
    );
  } else if (credentials?.status === "auth_needed") {
    tone = "waiting";
    title = "Reached, but someone needs to connect an account";
    body = (
      <ul className="m-0 list-disc pl-4">
        {credentials.authNeeded.map((entry) => (
          <li key={`${entry.reason}:${entry.providerDomain ?? ""}:${entry.message ?? ""}`}>
            {entry.message ?? entry.reason}
            {entry.providerDomain ? ` (${entry.providerDomain})` : null}
          </li>
        ))}
      </ul>
    );
  } else {
    tone = "success";
    title = "Connected";
    body = credentials ? (
      <>
        <p className="m-0">Runs would get these. Only names are shown, never values.</p>
        <CredentialList credentials={credentials} />
        <p className="m-0 mt-1.5 text-xs leading-4.5 text-fg-muted">
          {expiryLine(credentials.expiresAt)}
        </p>
      </>
    ) : null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-3" data-slot="endpoint-test-result">
      <Notice
        tone={tone}
        title={title}
        live={result.ok ? "polite" : "assertive"}
        onDismiss={onDismiss}
        dismissLabel="Hide test result"
      >
        <div className="flex min-w-0 flex-col gap-1">
          {body}
          <p className="m-0 text-xs leading-4.5 text-fg-muted">
            <RelativeTime date={testedAt} /> · {result.durationMs} ms
          </p>
        </div>
      </Notice>
      <Disclosure
        title={result.responseBody ? "Request and response" : "Request"}
        summary={
          result.responseBody
            ? "The signed request Opengeni sent and what came back"
            : "The signed request Opengeni sent"
        }
      >
        <div className="flex min-w-0 flex-col gap-4 pt-2 pb-2">
          <CodeSample label="Request body" code={prettyJson(result.request)} />
          {result.responseBody ? (
            <CodeSample label="Response body" code={prettyJson(result.responseBody)} />
          ) : kind === "credential-provider" && result.ok ? (
            <p className="m-0 text-xs leading-4.5 text-fg-muted">
              The response isn't shown because it holds credentials.
            </p>
          ) : null}
        </div>
      </Disclosure>
    </div>
  );
}
