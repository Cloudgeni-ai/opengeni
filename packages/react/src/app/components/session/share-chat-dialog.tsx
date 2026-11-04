// Share a chat with a read-only link. The person who started the chat creates
// one link; anyone holding it reads the conversation as it was at that moment
// (their messages and the replies, never tool details or files), without
// signing in. "Update link" refreshes what the same link shows; "Stop
// sharing" ends it. The agent does the same through its in-chat actions.
import type { OpenGeniClient, SessionShareLinkState } from "@opengeni/sdk";
import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { apiErrorFacts } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { CopyField } from "../../../ui/copy-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../ui/dialog";
import { ErrorMessage } from "../../../ui/error-message";
import { RelativeTime } from "../../../ui/relative-time";
import { Skeleton } from "../../../ui/skeleton";

type ShareChatClient = Pick<
  OpenGeniClient,
  "getSessionShareLink" | "createSessionShareLink" | "revokeSessionShareLink"
>;

type Busy = "create" | "update" | "stop" | null;

type Load =
  | { kind: "loading" }
  | { kind: "failed"; error: unknown }
  | { kind: "ready"; state: SessionShareLinkState };

/** The server's own sentence when it has one (refusals are written for people), else ours. */
function errorTitle(error: unknown, fallback: string): string {
  const facts = apiErrorFacts(error);
  return facts.status !== undefined && facts.status < 500 && facts.serverMessage
    ? facts.serverMessage
    : fallback;
}

export function ShareChatDialog({
  client,
  workspaceId,
  sessionId,
  open,
  onOpenChange,
}: {
  client: ShareChatClient;
  workspaceId: string;
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<{ title: string; error: unknown } | null>(null);
  const [stopped, setStopped] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoad({ kind: "loading" });
      try {
        const state = await client.getSessionShareLink(workspaceId, sessionId);
        if (!signal?.aborted) setLoad({ kind: "ready", state });
      } catch (error) {
        if (!signal?.aborted) setLoad({ kind: "failed", error });
      }
    },
    [client, workspaceId, sessionId],
  );

  useEffect(() => {
    if (!open) return;
    setActionError(null);
    setStopped(false);
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [open, refresh]);

  const run = async (kind: Exclude<Busy, null>) => {
    setBusy(kind);
    setActionError(null);
    try {
      if (kind === "stop") {
        await client.revokeSessionShareLink(workspaceId, sessionId);
        setStopped(true);
        setLoad((current) =>
          current.kind === "ready"
            ? { kind: "ready", state: { ...current.state, link: null } }
            : current,
        );
      } else {
        const link = await client.createSessionShareLink(workspaceId, sessionId);
        setStopped(false);
        setLoad({ kind: "ready", state: { enabled: true, link } });
      }
    } catch (error) {
      setActionError({
        title: errorTitle(
          error,
          kind === "stop"
            ? "Couldn't stop sharing. The link still works."
            : kind === "update"
              ? "Couldn't update the link. It still shows the earlier conversation."
              : "Couldn't create a link. Nothing was shared.",
        ),
        error,
      });
    } finally {
      setBusy(null);
    }
  };

  const link = load.kind === "ready" ? load.state.link : null;
  const disabled = load.kind === "ready" && !load.state.enabled;
  const facts = actionError ? apiErrorFacts(actionError.error) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" data-share-chat-dialog={load.kind}>
        <DialogHeader>
          <DialogTitle>{link ? "This chat is shared" : "Share this chat"}</DialogTitle>
          <DialogDescription>
            {disabled
              ? "Share links are turned off on this server."
              : link
                ? "Anyone with this link can read the conversation up to when you shared it, without signing in. Tool details and files aren't included."
                : "Anyone with the link can read the conversation up to now, without signing in: the messages, with who sent them, and the replies. Tool details and files aren't included."}
          </DialogDescription>
        </DialogHeader>

        {load.kind === "loading" ? (
          <div className="grid gap-2" aria-busy="true" aria-label="Checking this chat's link">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : load.kind === "failed" ? (
          <ErrorMessage
            variant="inline"
            title={errorTitle(load.error, "Couldn't check whether this chat is shared.")}
            reference={apiErrorFacts(load.error).reference}
            action={
              <Button type="button" variant="link" size="xs" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          />
        ) : link ? (
          <div className="grid min-w-0 gap-2">
            <CopyField variant="field" label="share link" value={link.url} />
            <p className="text-sm text-fg-muted">
              Shows the conversation as it was <RelativeTime date={link.updatedAt} inSentence />.
              New messages stay private until you update the link.
            </p>
          </div>
        ) : stopped ? (
          <p role="status" className="text-sm text-fg-muted">
            Sharing stopped. The link doesn't open anymore.
          </p>
        ) : null}

        {actionError ? (
          <ErrorMessage
            variant="inline"
            announce
            title={actionError.title}
            reference={facts?.reference}
          />
        ) : null}

        <DialogFooter className="gap-2">
          {link ? (
            <>
              <Button
                type="button"
                variant="ghost"
                className="text-danger hover:text-danger sm:mr-auto"
                disabled={busy !== null}
                onClick={() => void run("stop")}
              >
                {busy === "stop" ? <Loader2Icon className="size-4 animate-spin" /> : null}
                Stop sharing
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void run("update")}
              >
                {busy === "update" ? <Loader2Icon className="size-4 animate-spin" /> : null}
                Update link
              </Button>
              <Button type="button" disabled={busy !== null} onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => onOpenChange(false)}
              >
                {disabled || stopped ? "Close" : "Cancel"}
              </Button>
              {load.kind === "ready" && load.state.enabled ? (
                <Button type="button" disabled={busy !== null} onClick={() => void run("create")}>
                  {busy === "create" ? <Loader2Icon className="size-4 animate-spin" /> : null}
                  Create link
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
