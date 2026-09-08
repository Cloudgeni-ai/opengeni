import { ContextTextReader } from "./context-text-reader";
import type { SessionModelContextResponse } from "@opengeni/sdk";
import { ArrowLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppContext } from "@/context";
import type { SessionEvent } from "@/types";

const PAGE_SIZE = 30;
const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? "";
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readable).join("\n\n");
  const data = record(value);
  if (typeof data.text === "string") return data.text;
  if (["input_image", "image_url"].includes(String(data.type))) return "Image attachment";
  if (data.encrypted_content)
    return (
      "Encrypted content. Token count unavailable." +
      (data.summary ? "\n" + readable(data.summary) : "")
    );
  return readableField(data) ?? json(value);
}
function readableField(data: Record<string, unknown>): string | undefined {
  const value = data.content ?? data.output ?? data.arguments;
  return value == null ? undefined : readable(value);
}
function labelFor(value: unknown): string {
  const data = record(value);
  if (data.role)
    return (
      (
        {
          user: "You",
          assistant: "Assistant",
          developer: "Developer",
          system: "System",
          tool: "Tool result",
        } as Record<string, string>
      )[String(data.role)] ?? String(data.role)
    );
  if (data.type === "function_call") return "Tool call · " + String(data.name ?? "");
  if (data.type === "function_call_output") return "Tool result";
  if (data.type === "reasoning") return "Reasoning";
  if (data.type === "compaction") return "Compacted history";
  return typeof value === "string" ? "Input" : String(data.type ?? "Message");
}
function tokenLabel(value: number | null | undefined) {
  return value == null ? "Unknown tokens" : "~" + value.toLocaleString() + " tokens";
}
export function ModelContextInspectorPane(props: {
  workspaceId: string;
  sessionId: string;
  events: SessionEvent[];
  isRunning?: boolean;
}) {
  const { client } = useAppContext();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SessionModelContextResponse | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<SessionModelContextResponse | null>(null);
  const currentCapture = useRef<string | null>(null);
  const loadNext = useRef(false);
  useEffect(() => {
    setResponse(null);
    setPending(null);
    currentCapture.current = null;
  }, [client, props.workspaceId, props.sessionId]);
  // Fetch while mounted, including when a capture commits after a stream event.
  // One request at a time; obsolete responses cannot leak across sessions.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setError(null);
    let followUp = false;
    const fetchSnapshot = async () => {
      try {
        const next = await client.getSessionModelContext(props.workspaceId, props.sessionId);
        if (!cancelled) {
          const key = next.snapshot
            ? `${next.attemptId}:${next.snapshot.requestIndex}:${next.snapshot.capturedAt}`
            : null;
          if (currentCapture.current === null || loadNext.current) {
            currentCapture.current = key;
            loadNext.current = false;
            setResponse(next);
            setPending(null);
          } else if (key !== currentCapture.current) {
            setPending(next);
          }
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (props.isRunning || !followUp) {
            followUp = true;
            timer = setTimeout(fetchSnapshot, 5000);
          }
        }
      }
    };
    void fetchSnapshot();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, props.workspaceId, props.sessionId, props.isRunning, refresh]);

  const snapshot = response?.snapshot;
  const wire = snapshot?.providerRequest;
  const payload = useMemo(() => (wire?.body ? record(JSON.parse(wire.body)) : null), [wire?.body]);
  const [section, setSection] = useState("conversation");
  const [query, setQuery] = useState("");
  const [largest, setLargest] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [rawItem, setRawItem] = useState(false);
  useEffect(() => {
    setSection("conversation");
    setQuery("");
    setPage(0);
    setSelected(null);
  }, [props.workspaceId, props.sessionId]);
  const conversationKey = payload && "messages" in payload ? "messages" : "input";
  const partFor = (key: string) => wire?.parts.find((part) => part.key === key);
  const rows = useMemo(() => {
    const field = payload?.[section === "tools" ? "tools" : conversationKey];
    const values = Array.isArray(field) ? field : field == null ? [] : [field];
    const counts = wire?.parts.find(
      (part) => part.key === (section === "tools" ? "tools" : conversationKey),
    )?.itemEstimatedTokens;
    return values.map((value, index) => {
      const data = record(value);
      const definition = data.function ? record(data.function) : data;
      const label =
        section === "tools" ? String(definition.name ?? data.type ?? "Tool") : labelFor(value);
      const text = section === "tools" ? json(value) : readable(value);
      const preview =
        section === "tools"
          ? String(definition.description ?? data.type ?? "Tool definition")
          : text;
      return {
        index,
        value,
        label,
        text,
        preview: preview.slice(0, 180).replace(/\s+/g, " "),
        search: (label + " " + text).toLowerCase(),
        tokens: counts?.[index],
      };
    });
  }, [payload, section, conversationKey, wire?.parts]);
  const filtered = useMemo(() => {
    const result = rows.filter((row) => row.search.includes(query.toLowerCase()));
    return result.sort((a, b) =>
      largest
        ? (b.tokens ?? -1) - (a.tokens ?? -1) || a.index - b.index
        : section === "tools"
          ? a.index - b.index
          : b.index - a.index,
    );
  }, [rows, query, largest, section]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const selectedRow = selected == null ? null : rows[selected];
  const listSection = section === "conversation" || section === "tools";
  const navigate = (next: string) => {
    setSection(next);
    setSelected(null);
    setQuery("");
    setPage(0);
    setRawItem(false);
  };
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="model-context-inspector"
    >
      <header className="shrink-0 space-y-3 border-b border-border p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">Captured model request</h3>
            <p className="mt-1 text-2xs text-fg-subtle break-words">
              {typeof payload?.model === "string" ? payload.model + " · " : ""}
              {snapshot ? new Date(snapshot.capturedAt).toLocaleTimeString() : "No capture yet"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh model context"
            disabled={loading}
            onClick={() => {
              loadNext.current = true;
              setSelected(null);
              setRefresh((n) => n + 1);
            }}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        {pending ? (
          <Button
            size="xs"
            variant="secondary"
            className="h-auto whitespace-normal"
            onClick={() => {
              currentCapture.current = pending.snapshot
                ? `${pending.attemptId}:${pending.snapshot.requestIndex}:${pending.snapshot.capturedAt}`
                : null;
              setResponse(pending);
              setPending(null);
              setSelected(null);
              setPage(0);
            }}
          >
            New request available · Load latest
          </Button>
        ) : null}
        {payload ? (
          <>
            <div className="flex flex-wrap gap-1" aria-label="Context sections">
              {(
                [
                  ["conversation", "Conversation", conversationKey],
                  ["instructions", "Instructions", "instructions"],
                  ["tools", "Tools", "tools"],
                ] as const
              ).map(([id, label, key]) => (
                <Button
                  key={id}
                  size="xs"
                  variant={section === id ? "secondary" : "ghost"}
                  aria-pressed={section === id}
                  onClick={() => navigate(id)}
                >
                  {label}
                  <span className="text-fg-subtle">
                    {partFor(key)?.estimatedTokens == null
                      ? ""
                      : "~" + partFor(key)!.estimatedTokens!.toLocaleString() + " tokens"}
                  </span>
                </Button>
              ))}
            </div>
            {listSection && !selectedRow ? (
              <>
                <Input
                  aria-label="Search captured context"
                  placeholder={
                    section === "tools"
                      ? "Search tool definitions…"
                      : "Search all captured messages…"
                  }
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPage(0);
                  }}
                />
                <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-fg-subtle">
                  <span>
                    {filtered.length.toLocaleString()} {section === "tools" ? "tools" : "items"}
                    {query ? " matching" : " in this request"}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setLargest(!largest);
                      setPage(0);
                    }}
                  >
                    {largest
                      ? "Sort: Largest"
                      : section === "tools"
                        ? "Sort: Request order"
                        : "Sort: Newest"}
                  </Button>
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </header>
      <ScrollArea
        key={section + ":" + selected + ":" + currentPage}
        className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
      >
        <div className="min-w-0 p-3">
          {error ? (
            <p role="alert" className="text-xs text-status-waiting">
              Could not refresh context. {error}
            </p>
          ) : null}
          {loading && !snapshot ? <p className="text-xs text-fg-subtle">Loading context…</p> : null}
          {!loading && !snapshot ? (
            <p className="text-xs text-fg-subtle">No model request captured yet.</p>
          ) : null}
          {snapshot && !payload ? (
            <>
              <p className="text-xs text-fg-subtle">
                {wire?.unavailableReason ??
                  "This older capture contains only instructions. The full request was not recorded."}
              </p>
              <ContextTextReader text={snapshot.instructions} />
            </>
          ) : null}
          {payload && listSection ? (
            selectedRow ? (
              <div className="space-y-4">
                <Button size="xs" variant="ghost" onClick={() => setSelected(null)}>
                  <ArrowLeftIcon className="size-3" />
                  Back to results
                </Button>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-medium break-words">
                    #{selectedRow.index + 1} · {selectedRow.label}
                  </h4>
                  <span className="text-xs text-fg-subtle">{tokenLabel(selectedRow.tokens)}</span>
                </div>
                <Button size="xs" variant="secondary" onClick={() => setRawItem(!rawItem)}>
                  {rawItem ? "Read content" : "View item JSON"}
                </Button>
                <ContextTextReader
                  key={String(selected) + rawItem}
                  code={rawItem || section === "tools"}
                  initialQuery={
                    selectedRow.text.toLowerCase().includes(query.toLowerCase()) ? query : ""
                  }
                  text={rawItem ? json(selectedRow.value) : selectedRow.text}
                />
              </div>
            ) : (
              <div>
                {filtered.length === 0 ? (
                  <p className="py-4 text-xs text-fg-subtle">
                    {query
                      ? "No matching items. Try a different search."
                      : "No items in this request."}
                  </p>
                ) : null}
                {filtered
                  .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
                  .map((row) => (
                    <button
                      key={row.index}
                      type="button"
                      data-context-row
                      className="group flex w-full min-w-0 items-center gap-3 border-b border-border py-3 text-left hover:bg-bg-muted focus-visible:outline focus-visible:outline-2"
                      onClick={() => {
                        setSelected(row.index);
                        setRawItem(false);
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                          <span className="min-w-0 truncate text-xs font-medium">
                            #{row.index + 1} · {row.label}
                          </span>
                          <span className="shrink-0 text-2xs text-fg-subtle">
                            {tokenLabel(row.tokens)}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-fg-muted">
                          {row.preview || "Empty content"}
                        </p>
                      </div>
                      <ChevronRightIcon className="size-3 shrink-0 text-fg-subtle" />
                    </button>
                  ))}
              </div>
            )
          ) : null}
          {payload && section === "instructions" ? (
            <ContextTextReader
              key={"instructions:" + snapshot?.capturedAt}
              text={
                payload.instructions == null
                  ? "No separate instructions field. System and developer messages appear in Conversation."
                  : readable(payload.instructions)
              }
            />
          ) : null}
          {payload && section === "raw" ? (
            <ContextTextReader code key={"request:" + snapshot?.capturedAt} text={wire!.body!} />
          ) : null}
        </div>
      </ScrollArea>
      {payload ? (
        <footer className="shrink-0 space-y-2 border-t border-border p-2">
          {listSection && !selectedRow && pages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-1">
              <Button
                size="xs"
                variant="ghost"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </Button>
              <span className="text-2xs text-fg-subtle">
                {currentPage * PAGE_SIZE + 1}–
                {Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of{" "}
                {filtered.length.toLocaleString()}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={currentPage === pages - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="text-2xs text-fg-subtle">Captured request · tokens estimated</span>
            <Button variant="ghost" size="xs" onClick={() => navigate("raw")}>
              Request JSON
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
