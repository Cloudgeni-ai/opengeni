import { ArrowUpRightIcon, CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { CodingAgentTabs } from "@/components/onboarding/coding-agent-tabs";
import {
  FirstApiSessionStatus,
  useFirstApiSession,
} from "@/components/onboarding/first-api-session";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { useCopyToClipboard } from "@/components/ui/copy-field";
import { Disclosure } from "@/components/ui/disclosure";
import { SecretOnce } from "@/components/ui/secret-field";
import { useAppContext } from "@/context";
import { analyticsAction } from "@/lib/analytics-actions";
import { userErrorText } from "@/lib/api-error";
import {
  codingAgentSetupBlock,
  developerPluginGuides,
  DEVELOPER_PLUGIN_GUIDE_URL,
  EMBED_WITH_CODING_AGENT_URL,
} from "@/lib/coding-agent-setup";

/**
 * Put an agent in a product with the person's own coding agent, in one click:
 * "Copy setup for my coding agent" creates the API key (shown once, kept only
 * in this page's memory) and copies one block with the plugin install, the
 * prompt and where the key goes. Then it watches for the product's first
 * chat. The per-agent tabs, the prompt and the guides wait under Show details.
 */
export function OwnAgentSetup({
  organizationId,
  workspaceId,
  canCreateApiKeys,
  prompt,
  mcpUrl,
  firstSessionSeen,
  onMark,
  className,
}: {
  organizationId: string;
  workspaceId: string;
  canCreateApiKeys: boolean;
  /** What to paste into the coding agent. */
  prompt: string;
  /** The workspace MCP server, offered to Claude Code where coding agents can sign in. */
  mcpUrl?: string | null;
  /** The product's first chat already arrived (stop watching). */
  firstSessionSeen: boolean;
  onMark: (mark: "api_key" | "coding_agent" | "first_api_session") => void;
  className?: string;
}) {
  const context = useAppContext();
  // The key exists only here and in what was copied; it is never stored.
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clipboard = useCopyToClipboard();
  const firstSession = useFirstApiSession(workspaceId, !firstSessionSeen, () =>
    onMark("first_api_session"),
  );
  const workspaceName =
    context.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Development";

  const copySetup = async () => {
    setBusy(true);
    try {
      let key = token;
      if (!key && canCreateApiKeys) {
        const created = await context.client.createOrganizationApiKey(organizationId, {
          name: "My first agent",
          description: "Created while building your first agent",
        });
        key = created.token;
        setToken(key);
        onMark("api_key");
      }
      const ok = await clipboard.copy(codingAgentSetupBlock({ prompt, apiKey: key }));
      if (ok) onMark("coding_agent");
    } catch (error) {
      toast.error("Couldn't create the API key", { description: userErrorText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className ?? "flex min-w-0 flex-col gap-4"}>
      <div className="grid gap-2">
        <div>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void copySetup()}
            {...analyticsAction("copy_build_prompt")}
          >
            {busy ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            ) : clipboard.state === "copied" ? (
              <CheckIcon className="size-4" aria-hidden="true" />
            ) : (
              <CopyIcon className="size-4" aria-hidden="true" />
            )}
            {clipboard.state === "copied" ? "Copied" : "Copy setup for my coding agent"}
          </Button>
        </div>
        <p className="text-xs leading-4.5 text-fg-muted" aria-live="polite">
          {clipboard.state === "failed"
            ? "Couldn't copy automatically. Open Show details to copy each part."
            : "Paste it into Claude Code, Codex or Cursor."}
        </p>
        {token ? <SecretOnce className="mt-1" value={token} /> : null}
        <FirstApiSessionStatus
          state={firstSession}
          done={firstSessionSeen}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
        />
      </div>
      <Disclosure title="Show details">
        <div className="flex min-w-0 flex-col gap-4">
          <CodingAgentTabs
            guides={developerPluginGuides({ mcpUrl: mcpUrl ?? null })}
            onCopied={() => onMark("coding_agent")}
          />
          <CodeBlock
            label="For your coding agent"
            code={prompt}
            wrap="words"
            copyLabel="Copy prompt"
            copyAnalytics={analyticsAction("copy_build_prompt")}
          />
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <ExternalLink href={DEVELOPER_PLUGIN_GUIDE_URL}>Developer plugin</ExternalLink>
            <ExternalLink href={EMBED_WITH_CODING_AGENT_URL}>
              Embed with your coding agent
            </ExternalLink>
          </p>
        </div>
      </Disclosure>
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 font-medium text-fg underline-offset-2 hover:underline"
    >
      {children}
      <ArrowUpRightIcon aria-hidden="true" className="size-3.5 text-fg-muted" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
