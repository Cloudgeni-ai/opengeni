import type { ReactNode } from "react";

/* ----------------------------------------------------------------------------
   "Claude Code (API key)": the Anthropic API-key connection, introduced for
   people whose Claude plan includes monthly API credits. It adds no provider
   of its own; the key below is saved as the Anthropic API connection.
   -------------------------------------------------------------------------- */

const CREDITS_DOCS_URL =
  "https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers";
const CONSOLE_KEYS_URL = "https://platform.claude.com/settings/keys";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  );
}

/** What the plan's API credits are and how to get an API key that spends them. */
export function ClaudeCodeApiIntro() {
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-bg p-4 text-sm leading-5 text-fg-muted">
      <p className="m-0">
        Claude Max, Ultra and Team plans include monthly API credits; Pro, Free and Enterprise
        don&rsquo;t. The credits pay for API use like Opengeni&rsquo;s, not for the Claude Code app,
        so to spend them you connect an Anthropic API key here instead of signing in with your plan.{" "}
        <ExternalLink href={CREDITS_DOCS_URL}>Anthropic lists the amounts</ExternalLink>.
      </p>
      <ol className="m-0 grid list-decimal gap-1 pl-5">
        <li>
          On claude.ai in a web browser, open Settings &rarr; Billing &rarr; API credits and link a
          Claude Console organization. You need an Owner, Admin or Billing role in that
          organization.
        </li>
        <li>
          In the <ExternalLink href={CONSOLE_KEYS_URL}>Claude Console</ExternalLink>, create an API
          key for that organization.
        </li>
        <li>Paste the key below.</li>
      </ol>
      <p className="m-0">
        The credits expire at the end of each billing period and don&rsquo;t roll over.
      </p>
    </div>
  );
}
