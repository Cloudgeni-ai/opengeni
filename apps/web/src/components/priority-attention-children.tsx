import type { AgentTopologySession } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAppContext } from "@/context";

/** Load only when requested, through the same authorized topology as Agents. */
export function PriorityAttentionChildren({
  workspaceId,
  rootSessionId,
  label = "Show waiting agents",
}: {
  workspaceId: string;
  rootSessionId: string;
  label?: string;
}) {
  const { client } = useAppContext();
  const generation = useRef(0);
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [sessions, setSessions] = useState<AgentTopologySession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  async function load(nextCursor?: string) {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const page = await client.listAgentTopology(workspaceId, {
        rootSessionId,
        statuses: ["requires_action"],
        limit: 20,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      });
      if (generation.current !== request) return;
      const children = page.sessions.filter(
        (session) => session.id !== rootSessionId && session.status === "requires_action",
      );
      setSessions((current) =>
        nextCursor
          ? [...new Map([...current, ...children].map((session) => [session.id, session])).values()]
          : children,
      );
      setCursor(page.nextCursor);
    } catch {
      if (generation.current === request) setError(true);
    } finally {
      if (generation.current === request) {
        pending.current = false;
        setLoading(false);
      }
    }
  }

  return (
    <div className="pt-1 text-xs">
      <button
        type="button"
        className="font-medium text-brand hover:underline"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        {open ? "Hide waiting agents" : label}
      </button>
      {open ? (
        <div className="mt-2 grid gap-2 border-l border-border pl-3">
          {sessions.map((session) => (
            <div key={session.id} className="grid gap-0.5">
              <Link
                to="/workspaces/$workspaceId/sessions/$sessionId"
                params={{ workspaceId, sessionId: session.id }}
                className="font-medium text-brand hover:underline"
              >
                {session.title || "Untitled session"}
              </Link>
              <span className="text-fg-subtle">
                {session.pause.state === "paused"
                  ? "Paused; request still pending"
                  : "Needs input in this session"}
              </span>
            </div>
          ))}
          {loading ? <p role="status">Checking waiting agents…</p> : null}
          {error ? (
            <p role="alert">
              Waiting agents could not be loaded. Try refreshing.{" "}
              {sessions.length > 0 ? "The listed agents are from the previous check." : ""}
            </p>
          ) : null}
          {!loading && !error && sessions.length === 0 && !cursor ? (
            <p role="status">No waiting agents were found. The parent summary may have changed.</p>
          ) : null}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={loading}
              className="underline disabled:opacity-50"
              onClick={() => void load()}
            >
              Refresh waiting agents
            </button>
            {cursor ? (
              <button
                type="button"
                disabled={loading}
                className="underline disabled:opacity-50"
                onClick={() => void load(cursor)}
              >
                Load more waiting agents
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
