import type { SessionModelContextResponse } from "@opengeni/sdk";
import { CopyIcon, Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { CopyableMono, InfoRow, InspectorSection } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppContext } from "@/context";
import type { SessionEvent } from "@/types";

function formatTokens(value: number): string {
  return `${value.toLocaleString()} tok`;
}

export function providerUsageFromEvents(events: SessionEvent[]): {
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
} | null {
  const usage = [...events]
    .filter((event) => event.type === "agent.model.usage")
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (!usage || !usage.payload || typeof usage.payload !== "object") return null;
  const payload = usage.payload as Record<string, unknown>;
  const numberOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    inputTokens: numberOrNull(payload.inputTokens),
    cachedTokens: numberOrNull(payload.cachedTokens),
    outputTokens: numberOrNull(payload.outputTokens),
  };
}

export function ModelContextInspectorPane(props: {
  workspaceId: string;
  sessionId: string;
  events: SessionEvent[];
}) {
  const context = useAppContext();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SessionModelContextResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void context.client
      .getSessionModelContext(props.workspaceId, props.sessionId)
      .then((next) => {
        if (!cancelled) setResponse(next);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [context.client, props.sessionId, props.workspaceId]);

  const providerUsage = useMemo(() => providerUsageFromEvents(props.events), [props.events]);
  const snapshot = response?.snapshot ?? null;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-fg-subtle">
        <Loader2Icon className="size-4 animate-spin" />
        Loading model context…
      </div>
    );
  }
  if (error) {
    return <p className="p-3 text-xs text-status-waiting">{error}</p>;
  }
  if (!snapshot) {
    return (
      <p className="p-3 text-xs text-fg-subtle">
        No captured model request yet. The exact prefix appears here after the agent’s first
        provider call.
      </p>
    );
  }

  return (
    <ScrollArea className="h-full min-w-0">
      <div className="min-w-0 space-y-4 p-3">
        <InspectorSection title="Token counts">
          <InfoRow label="Instructions" value={formatTokens(snapshot.tokens.instructions)} />
          <InfoRow label="Tools" value={formatTokens(snapshot.tokens.tools)} />
          <InfoRow label="Prefix total" value={formatTokens(snapshot.tokens.prefix)} />
          <InfoRow
            label="Provider input"
            value={
              providerUsage?.inputTokens != null
                ? `${formatTokens(providerUsage.inputTokens)} (reported)`
                : "unavailable"
            }
          />
          {providerUsage?.cachedTokens != null ? (
            <InfoRow label="Provider cached" value={formatTokens(providerUsage.cachedTokens)} />
          ) : null}
          <p className="text-2xs text-fg-subtle">
            Prefix counts cover only what was on the wire: the sent system instructions plus eager
            tool schemas. Searchable tools are listed below but not counted. Estimates are
            conservative (ASCII/4, non-ASCII counted fully). Provider input is the last reported
            complete request, including conversation history.
          </p>
          <InfoRow label="Request" value={`#${snapshot.requestIndex}`} />
          {response?.attemptId ? (
            <InfoRow label="Attempt" value={<CopyableMono value={response.attemptId} />} />
          ) : null}
        </InspectorSection>

        <InspectorSection title="System instructions">
          <p className="text-2xs text-fg-subtle">
            Raw <code>systemInstructions</code> from the provider ModelRequest at{" "}
            <code>getResponse</code>/<code>getStreamedResponse</code>, after sandbox wrapping, input
            filters, and lazy-tool hiding. The OpenAI Responses client sends this same string as{" "}
            <code>instructions</code>.
          </p>
          <pre className="max-h-96 max-w-full overflow-auto rounded-md border border-border bg-bg/35 p-2 text-2xs leading-5 whitespace-pre-wrap text-fg-muted">
            {snapshot.instructions}
          </pre>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              void navigator.clipboard.writeText(snapshot.instructions).then(
                () => toast.success("Copied the sent system instructions"),
                (caught) =>
                  toast.error("Could not copy", {
                    description: caught instanceof Error ? caught.message : String(caught),
                  }),
              );
            }}
          >
            <CopyIcon className="size-3" />
            Copy sent instructions
          </Button>
          <div className="text-xs font-medium">Split for reading</div>
          <p className="text-2xs text-fg-subtle">
            Derived from the sent string above. The raw block is the source of truth.
          </p>
          {snapshot.layers.map((layer) => (
            <Collapsible
              key={`${layer.id}:${layer.title}:${layer.utf8Bytes}`}
              className="min-w-0 overflow-hidden rounded-md border border-border bg-bg/35"
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center justify-between gap-2 p-2 text-left"
                >
                  <span className="truncate text-xs font-medium">{layer.title}</span>
                  <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                    {formatTokens(layer.estimatedTokens)}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="max-h-80 max-w-full overflow-auto border-t border-border p-2 text-2xs leading-5 whitespace-pre-wrap text-fg-muted">
                  {layer.content}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </InspectorSection>

        <InspectorSection title="Tools as the model sees them">
          <p className="text-2xs text-fg-subtle">
            Eager tools are the raw <code>tools</code> array on that same ModelRequest. Searchable
            tools stay behind tool_search until disclosed and were not sent.
          </p>
          {snapshot.tools.map((tool) => (
            <Collapsible
              key={`${tool.visibility}:${tool.name}`}
              className="min-w-0 overflow-hidden rounded-md border border-border bg-bg/35"
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center justify-between gap-2 p-2 text-left"
                >
                  <span className="min-w-0 truncate text-xs font-medium">
                    {tool.name}{" "}
                    <span className="font-normal text-fg-subtle">
                      {tool.visibility}
                      {tool.namespace ? ` · ${tool.namespace}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                    {formatTokens(tool.estimatedTokens)}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="max-h-80 max-w-full overflow-auto border-t border-border p-2 text-2xs leading-5 text-fg-muted">
                  {JSON.stringify(
                    {
                      type: tool.type,
                      name: tool.name,
                      visibility: tool.visibility,
                      description: tool.description,
                      namespace: tool.namespace,
                      schema: tool.schema,
                    },
                    null,
                    2,
                  )}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </InspectorSection>

        <InspectorSection title="Skills">
          <p className="text-2xs text-fg-subtle">
            Parsed from the sent instructions and skill activations. Skills are not a separate
            provider field.
          </p>
          {snapshot.skills.length === 0 ? (
            <p className="text-xs text-fg-subtle">
              No skill descriptors were parsed from the sent instructions.
            </p>
          ) : (
            snapshot.skills.map((skill) => (
              <div
                key={`${skill.kind}:${skill.name}`}
                className="rounded-md border border-border bg-bg/35 p-2"
              >
                <div className="text-xs font-medium">{skill.name}</div>
                <div className="mt-1 text-2xs text-fg-subtle">
                  {skill.kind}
                  {skill.source ? ` · ${skill.source}` : ""}
                </div>
                <div className="mt-1 text-2xs text-fg-muted">{skill.description}</div>
              </div>
            ))
          )}
        </InspectorSection>
      </div>
    </ScrollArea>
  );
}
