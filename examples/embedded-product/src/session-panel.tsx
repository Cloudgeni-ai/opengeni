import { useMemo, useRef, useState } from "react";
import { OpenGeniClient, type FileAsset } from "@opengeni/sdk";
import { hostRequest } from "./transport";
import {
  useSession,
  useSessionEvents,
  useHumanInputRequests,
  projectPendingApprovals,
  useTurnQueue,
  useComposer,
  type AuthNeededItem,
} from "@opengeni/react/session";
import {
  MessageTimeline,
  ApprovalSurface,
  HumanInputSurface,
  QueueSurface,
} from "@opengeni/react/session-ui";
import "@opengeni/react/compiled.css";

/** Browser SDK carries no upstream credentials. The host admits all reads and
 * user events; the shared SDK owns SSE resume/dedup/compact event semantics. */
type SessionPanelProps = {
  workspaceId: string;
  sessionId: string;
  onReconnect: (item: AuthNeededItem) => Promise<void>;
};
export function SessionPanel(props: SessionPanelProps) {
  return <ScopedSessionPanel key={`${props.workspaceId}\u0000${props.sessionId}`} {...props} />;
}

function ScopedSessionPanel({ workspaceId, sessionId, onReconnect }: SessionPanelProps) {
  const client = useMemo(
    () =>
      new OpenGeniClient({
        baseUrl: window.location.origin,
        fetch: (input, init) => {
          const url = new URL(String(input));
          const match =
            /^\/v1\/workspaces\/([^/]+)\/sessions\/([^/]+)(\/events(?:\/stream)?|\/human-input-requests|\/queue(?:\/[^/]+\/(?:move|edit|steer|delete))?|\/composer-draft(?:\/submit)?|\/control)?$/.exec(
              url.pathname,
            );
          if (!match || decodeURIComponent(match[1]!) !== workspaceId)
            throw new Error("Session route is not exposed by this host example");
          const headers = new Headers(init?.headers);
          headers.set("x-embedded-product", "1");
          return fetch(`/api/sessions/${match[2]}${match[3] ?? ""}${url.search}`, {
            ...init,
            headers,
            credentials: "same-origin",
          });
        },
      }),
    [workspaceId],
  );
  const feed = useSessionEvents(sessionId, { client, workspaceId, replay: "full" });
  const detail = useSession(sessionId, {
    client,
    workspaceId,
    pollIntervalMs: 15_000,
    events: feed.events,
  });
  const humanInput = useHumanInputRequests(sessionId, {
    client,
    workspaceId,
    pollIntervalMs: 15_000,
    events: feed.events,
  });
  const approvals = useMemo(() => projectPendingApprovals(feed.events), [feed.events]);
  const queue = useTurnQueue(sessionId, {
    client,
    workspaceId,
    events: feed.events,
    pollIntervalMs: 15_000,
  });
  const [attachments, setAttachments] = useState<FileAsset[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  const uploadPending = useRef(false);
  const composer = useComposer(sessionId, {
    client,
    workspaceId,
    events: feed.events,
    effectiveControl: queue.snapshot?.effectiveControl,
    sendBlocked: () =>
      Boolean(detail.error || feed.error || queue.error || uploading || uploadFailed),
    sendExtras: { resources: attachments.map((file) => ({ kind: "file", fileId: file.id })) },
    onSent: (_text, input) => {
      const accepted = new Set(
        input.resources?.flatMap((resource) => (resource.kind === "file" ? [resource.fileId] : [])),
      );
      setAttachments((files) => files.filter((file) => !accepted.has(file.id)));
    },
  });
  const [failed, setFailed] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const controlPending = useRef(false);
  const control = async (action: "pause" | "resume" | "cancel") => {
    const expectedControlEtag = queue.snapshot?.effectiveControl.controlEtag;
    if (!expectedControlEtag || controlPending.current || detail.error || queue.error) return;
    controlPending.current = true;
    setControlling(true);
    setFailed(false);
    try {
      await client.controlSession(workspaceId, sessionId, {
        action,
        expectedControlEtag,
        clientEventId: crypto.randomUUID(),
      });
      await Promise.all([detail.refresh(), queue.refresh()]);
    } catch {
      setFailed(true);
    } finally {
      controlPending.current = false;
      setControlling(false);
      setConfirmCancel(false);
    }
  };
  return (
    <section aria-label="Site editing session">
      <h2>{detail.session?.title ?? "Edit with Geni"}</h2>
      <p role="status">
        {feed.sessionStatus ?? detail.session?.status ?? "Loading"} · {feed.connectionState}
      </p>
      <fieldset
        disabled={
          controlling ||
          failed ||
          !queue.snapshot ||
          Boolean(detail.error || queue.error || feed.error)
        }
      >
        <legend>Session control</legend>
        <button type="button" onClick={() => void control("pause")}>
          Pause session
        </button>
        <button type="button" onClick={() => void control("resume")}>
          Resume session
        </button>
        <button type="button" onClick={() => setConfirmCancel(true)}>
          Cancel session…
        </button>
        {confirmCancel && (
          <div role="group" aria-label="Confirm terminal session cancellation">
            <p>
              Cancel this session and its descendants permanently? Queued work is drained and new
              prompts are fenced. This cannot be resumed.
            </p>
            <button type="button" onClick={() => void control("cancel")}>
              Confirm cancellation
            </button>
            <button type="button" onClick={() => setConfirmCancel(false)}>
              Keep session
            </button>
          </div>
        )}
      </fieldset>
      <button
        type="button"
        disabled={controlling}
        onClick={() => {
          if (controlPending.current) return;
          controlPending.current = true;
          setControlling(true);
          void Promise.all([detail.refresh(), queue.refresh()])
            .then(() => setFailed(false))
            .catch(() => setFailed(true))
            .finally(() => {
              controlPending.current = false;
              setControlling(false);
            });
        }}
      >
        Refresh session state
      </button>
      {(failed || detail.error || feed.error) && (
        <p role="alert">
          Session state could not be confirmed. Check live state before resending a message.
        </p>
      )}
      {!detail.error && (
        <MessageTimeline
          items={feed.timeline}
          status={feed.sessionStatus ?? detail.session?.status}
          onReconnect={onReconnect}
        />
      )}
      {!detail.error && !feed.error && (
        <ApprovalSurface
          approvals={approvals}
          onApprove={async (approval) => {
            await client.sendApprovalDecision(workspaceId, sessionId, {
              approvalId: approval.id,
              decision: "approve",
              clientEventId: crypto.randomUUID(),
            });
          }}
          onReject={async (approval) => {
            await client.sendApprovalDecision(workspaceId, sessionId, {
              approvalId: approval.id,
              decision: "reject",
              clientEventId: crypto.randomUUID(),
            });
          }}
        />
      )}
      {!detail.error && !feed.error && <QueueSurface queue={queue} composer={composer} />}
      {!detail.error && !humanInput.error && (
        <HumanInputSurface
          requests={humanInput.requests}
          respondingRequestId={humanInput.respondingRequestId}
          error={
            humanInput.mutationError
              ? "Input state could not be confirmed. Refresh before retrying."
              : null
          }
          onSubmit={async (requestId, response) => {
            const result = await humanInput.respond(requestId, response);
            if (!result) throw new Error("Response was not confirmed");
          }}
        />
      )}
      <fieldset disabled={uploading || composer.sending || Boolean(detail.error || feed.error)}>
        <legend>Attach a workspace file</legend>
        <p>Files are shared with workspace members. This example accepts files up to 32 KiB.</p>
        <input
          type="file"
          aria-label="Upload workspace attachment"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file || uploadPending.current) return;
            if (file.size > 32_768) {
              setUploadFailed(true);
              return;
            }
            uploadPending.current = true;
            setUploading(true);
            setUploadFailed(false);
            try {
              const bytes = new Uint8Array(await file.arrayBuffer());
              const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
              const uploaded = await hostRequest<FileAsset>("files/upload", "POST", {
                filename: file.name,
                contentType: file.type || "application/octet-stream",
                base64,
              });
              setAttachments((files) => [...files, uploaded]);
            } catch {
              setUploadFailed(true);
            } finally {
              uploadPending.current = false;
              setUploading(false);
            }
          }}
        />
        {uploading && <p role="status">Uploading and verifying file…</p>}
        {uploadFailed && (
          <div role="alert">
            <p>
              Upload was not confirmed. A file may have been stored, but it has not been attached.
              Check the 32 KiB limit before uploading again.
            </p>
            <button type="button" onClick={() => setUploadFailed(false)}>
              Dismiss unresolved upload
            </button>
          </div>
        )}
        <ul>
          {attachments.map((file) => (
            <li key={file.id}>
              {file.filename}{" "}
              <button
                type="button"
                onClick={() =>
                  setAttachments((files) => files.filter((item) => item.id !== file.id))
                }
              >
                Remove attachment
              </button>
            </li>
          ))}
        </ul>
      </fieldset>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (composer.canSend) void composer.send();
        }}
      >
        <label>
          What should change?
          <textarea
            value={composer.value}
            onChange={(event) => composer.setValue(event.target.value)}
            disabled={composer.sending || composer.draftLoading}
            required
          />
        </label>
        <button type="submit" disabled={!composer.canSend}>
          Send message
        </button>
      </form>
      {composer.error && (
        <p role="alert">
          Draft or delivery could not be confirmed. Refresh the durable draft before continuing.
        </p>
      )}
      {composer.draftConflict && (
        <div role="group" aria-label="Resolve draft conflict">
          <p>The durable draft changed elsewhere. Choose which version to retain.</p>
          <button type="button" onClick={() => void composer.resolveDraftConflict("keep_mine")}>
            Keep my draft
          </button>
          <button type="button" onClick={() => void composer.resolveDraftConflict("use_remote")}>
            Use remote draft
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={composer.sending || composer.draftLoading}
        onClick={() => void composer.reloadDraft()}
      >
        Reload draft
      </button>
      {composer.restoredResources.length > 0 && (
        <ul aria-label="Draft attachments">
          {composer.restoredResources.map((resource, index) => (
            <li
              key={
                resource.kind === "file"
                  ? `file:${resource.fileId}:${resource.mountPath ?? ""}`
                  : `repository:${resource.uri}:${resource.ref}:${resource.mountPath ?? ""}`
              }
            >
              {resource.kind} attachment{" "}
              <button type="button" onClick={() => composer.removeRestoredResource(index)}>
                Remove attachment {index + 1}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p>
        This reference uses shared messaging, streaming, session control, queue display, approval
        and structured-input controls. Configure your product’s scheduling and file controls using
        the same session SDK; no permission rules are changed here.
      </p>
    </section>
  );
}
