import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ShieldCheckIcon } from "lucide-react";
import { useAppContext } from "@opengeni/react/app/app-context";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { FormPage } from "@opengeni/react/ui/form-dialog";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { ConsentFrame as BaseConsentFrame } from "@/components/organization-access/mcp-consent-page";

/*
 * Approving one tool call a connected agent (Claude Code, Codex, Cursor...)
 * asked for. The agent's link carries the call in its fragment, which never
 * reaches a server log. Approving here records the person's approval for
 * exactly this call (tool, arguments, operation); the agent then retries it
 * with the same operation id and it runs once. The server decides everything:
 * it re-resolves the tool and refuses a call that changed.
 */

export type PendingToolCall = {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  operationId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** The call in an approval link's fragment, or null when it isn't one. */
export function parsePendingToolCall(hash: string): PendingToolCall | null {
  const encoded = hash.replace(/^#/u, "");
  if (!encoded) return null;
  try {
    const padded = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PendingToolCall>;
    if (
      typeof value.serverId !== "string" ||
      typeof value.toolName !== "string" ||
      typeof value.operationId !== "string" ||
      !UUID.test(value.operationId) ||
      !value.arguments ||
      typeof value.arguments !== "object" ||
      Array.isArray(value.arguments)
    )
      return null;
    return {
      serverId: value.serverId,
      toolName: value.toolName,
      arguments: value.arguments,
      operationId: value.operationId,
    };
  } catch {
    return null;
  }
}

type Resolved = { definitionDigest: string; entry: { title?: string; description?: string } };

/** The consent frame scrolls itself inside the app canvas. */
function ConsentFrame({ children }: { children: ReactNode }) {
  return (
    <div data-workspace-scroll-owner="self-managed" className="flex h-full min-h-0 flex-col">
      <BaseConsentFrame>{children}</BaseConsentFrame>
    </div>
  );
}

export function ToolApprovalRoute({ workspaceId }: { workspaceId: string }) {
  const { client } = useAppContext();
  const call = useMemo(() => parsePendingToolCall(window.location.hash), []);
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}/tools`;
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    if (!call) return;
    const controller = new AbortController();
    client
      .requestJson<Resolved>(
        "POST",
        `${base}/resolve`,
        { target: { identity: { serverId: call.serverId, toolName: call.toolName } } },
        {},
        { signal: controller.signal },
      )
      .then(setResolved)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(userErrorText(caught, "This tool isn't available to you here."));
      });
    return () => controller.abort();
  }, [base, call, client]);

  if (!call)
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<ShieldCheckIcon />}
          title="This approval link is incomplete"
          description="Ask your agent for the link again."
        />
      </ConsentFrame>
    );

  if (approved)
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<ShieldCheckIcon />}
          title="Approved"
          description="Go back to your agent. It runs this call once, within 5 minutes."
        />
      </ConsentFrame>
    );

  const title = resolved?.entry.title ?? call.toolName;
  return (
    <ConsentFrame>
      <FormPage
        leading={<LogoTile icon={<ShieldCheckIcon />} />}
        title={`Allow ${title}?`}
        description="A connected agent asked to run this tool as you, once, with these inputs."
        submitLabel="Approve"
        submitDisabled={!resolved}
        pendingLabel="Approving…"
        cancelLabel={null}
        onSubmit={async () => {
          if (!resolved) return false;
          setError(null);
          try {
            await client.requestJson(
              "POST",
              `${base}/target-approvals`,
              {
                identity: { serverId: call.serverId, toolName: call.toolName },
                operationId: call.operationId,
                arguments: call.arguments,
                expectedDefinitionDigest: resolved.definitionDigest,
              },
              {},
            );
            setApproved(true);
          } catch (caught) {
            setError(userErrorText(caught, "It wasn't approved. Try again."));
          }
          return false;
        }}
      >
        <dl className="m-0 grid min-w-0 grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm leading-5">
          <dt className="text-fg-muted">Tool</dt>
          <dd className="m-0 min-w-0 break-words text-fg" translate="no">
            {call.serverId} / {call.toolName}
          </dd>
          <dt className="text-fg-muted">Inputs</dt>
          <dd className="m-0 min-w-0">
            <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-3 text-xs text-fg">
              {JSON.stringify(call.arguments, null, 2)}
            </pre>
          </dd>
        </dl>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </FormPage>
    </ConsentFrame>
  );
}
