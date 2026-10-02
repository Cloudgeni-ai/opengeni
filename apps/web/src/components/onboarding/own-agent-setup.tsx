import { ArrowUpRightIcon, Loader2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { CodingAgentTabs } from "@/components/onboarding/coding-agent-tabs";
import {
  FirstApiSessionStatus,
  useFirstApiSession,
} from "@/components/onboarding/first-api-session";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { SecretOnce } from "@/components/ui/secret-field";
import { useAppContext } from "@/context";
import { analyticsAction } from "@/lib/analytics-actions";
import { userErrorText } from "@/lib/api-error";
import {
  API_KEY_ENV_VAR,
  developerPluginGuides,
  DEVELOPER_PLUGIN_GUIDE_URL,
  EMBED_WITH_CODING_AGENT_URL,
} from "@/lib/coding-agent-setup";

/**
 * Put an agent in a product with the person's own coding agent: add the
 * Opengeni developer skills to it, create the API key the product's server
 * uses (shown once), paste one prompt, and watch for the product's first chat
 * in the workspace, which is the success. Shared by "Let's build your first
 * agent" and Get started.
 */
export function OwnAgentSetup({
  organizationId,
  workspaceId,
  canCreateApiKeys,
  prompt,
  promptDescription,
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
  promptDescription?: ReactNode;
  /** The workspace MCP server, offered to Claude Code where coding agents can sign in. */
  mcpUrl?: string | null;
  /** The product's first chat already arrived (stop watching). */
  firstSessionSeen: boolean;
  onMark: (mark: "api_key" | "coding_agent" | "first_api_session") => void;
  className?: string;
}) {
  const context = useAppContext();
  const [token, setToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const firstSession = useFirstApiSession(workspaceId, !firstSessionSeen, () =>
    onMark("first_api_session"),
  );
  const workspaceName =
    context.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Development";

  const createKey = async () => {
    setCreating(true);
    try {
      const created = await context.client.createOrganizationApiKey(organizationId, {
        name: "My first agent",
        description: "Created while building your first agent",
      });
      setToken(created.token);
      onMark("api_key");
    } catch (error) {
      toast.error("Couldn't create the API key", { description: userErrorText(error) });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={className ?? "flex min-w-0 flex-col gap-8"}>
      <section className="min-w-0" aria-labelledby="own-agent-skills">
        <h3 id="own-agent-skills" className="text-sm font-medium text-fg">
          1. Add the Opengeni skills to your coding agent
        </h3>
        <div className="mt-3">
          <CodingAgentTabs
            guides={developerPluginGuides({ mcpUrl: mcpUrl ?? null })}
            onCopied={() => onMark("coding_agent")}
          />
        </div>
      </section>
      <section className="min-w-0" aria-labelledby="own-agent-key">
        <h3 id="own-agent-key" className="text-sm font-medium text-fg">
          2. Create an API key
        </h3>
        {token ? (
          <SecretOnce
            className="mt-3"
            value={token}
            details={`Paste it into your product's .env as ${API_KEY_ENV_VAR}. It's named "My first agent" in Organization settings > Developer, where you can revoke it.`}
          />
        ) : canCreateApiKeys ? (
          <>
            <Button
              type="button"
              size="sm"
              className="mt-3"
              disabled={creating}
              onClick={() => void createKey()}
              {...analyticsAction("create_api_key")}
            >
              {creating ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
              Create API key
            </Button>
          </>
        ) : (
          <p className="mt-1 text-xs leading-4.5 text-fg-muted">
            Only organization owners can create API keys. Ask an owner for one.
          </p>
        )}
      </section>
      <section className="min-w-0" aria-labelledby="own-agent-prompt">
        <h3 id="own-agent-prompt" className="text-sm font-medium text-fg">
          3. Paste this prompt into your coding agent
        </h3>
        {promptDescription ? (
          <p className="mt-1 text-xs leading-4.5 text-fg-muted">{promptDescription}</p>
        ) : null}
        <CodeBlock
          className="mt-3"
          label="For your coding agent"
          code={prompt}
          wrap="words"
          copyLabel="Copy prompt"
          copyAnalytics={analyticsAction("copy_build_prompt")}
        />
        <FirstApiSessionStatus
          state={firstSession}
          done={firstSessionSeen}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
        />
      </section>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <ExternalLink href={DEVELOPER_PLUGIN_GUIDE_URL}>Developer plugin</ExternalLink>
        <ExternalLink href={EMBED_WITH_CODING_AGENT_URL}>Embed with your coding agent</ExternalLink>
      </p>
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
