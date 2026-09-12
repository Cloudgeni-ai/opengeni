import { useEffect, useRef, useState } from "react";
import type {
  OpenGeniClient,
  WorkspaceArtifact,
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListResponse,
} from "@opengeni/sdk";
import {
  PublishedHtmlArtifactFrame,
  type PublishedHtmlArtifactToolBridge,
} from "./components/artifacts/published-html-artifact-frame";

/** Implement with an authenticated host proxy. Never put an organization key
 * in browser props; replace the client object when the host actor changes. */
export type SiteClient = Pick<
  OpenGeniClient,
  | "listWorkspaceArtifacts"
  | "getWorkspaceArtifact"
  | "getWorkspaceArtifactHtml"
  | "rollbackWorkspaceArtifact"
  | "setWorkspaceArtifactStatus"
>;
type SiteDisplayContent = Pick<
  WorkspaceArtifactContentResponse,
  "artifactId" | "versionId" | "html" | "requestedTools"
>;
type SiteScope = { client: SiteClient; workspaceId: string; className?: string };
/** Shared native/embedded read boundary: pin content to the observed version,
 * and never accept a response belonging to another workspace or Site. */
export async function loadSiteSnapshot(
  client: Pick<SiteClient, "getWorkspaceArtifact" | "getWorkspaceArtifactHtml"> &
    Partial<Pick<OpenGeniClient, "getWorkspaceArtifactContent">>,
  workspaceId: string,
  siteId: string,
  options: { signal?: AbortSignal; includeArchivedContent?: boolean; versionId?: string } = {},
): Promise<{
  detail: WorkspaceArtifactDetailResponse;
  content: SiteDisplayContent | null;
}> {
  const requestOptions = options.signal ? { signal: options.signal } : {};
  const detail = await client.getWorkspaceArtifact(workspaceId, siteId, requestOptions);
  options.signal?.throwIfAborted();
  if (detail.artifact.id !== siteId || detail.artifact.workspaceId !== workspaceId)
    throw new Error("Site scope mismatch");
  const selectedVersion = options.versionId
    ? detail.versions.find((version) => version.id === options.versionId)
    : detail.artifact.currentVersion;
  const versionId = options.versionId ?? selectedVersion?.id;
  let content: SiteDisplayContent | null =
    selectedVersion &&
    versionId &&
    (detail.artifact.status === "active" || options.includeArchivedContent)
      ? {
          artifactId: siteId,
          versionId,
          requestedTools: selectedVersion!.requestedTools,
          html: await client.getWorkspaceArtifactHtml(workspaceId, siteId, {
            ...requestOptions,
            versionId,
          }),
        }
      : null;
  if (
    versionId &&
    !selectedVersion &&
    (detail.artifact.status === "active" || options.includeArchivedContent)
  ) {
    if (!client.getWorkspaceArtifactContent) throw new Error("Site version unavailable");
    content = await client.getWorkspaceArtifactContent(workspaceId, siteId, {
      ...requestOptions,
      versionId,
    });
  }
  options.signal?.throwIfAborted();
  if (content && (content.artifactId !== siteId || content.versionId !== versionId))
    throw new Error("Site content mismatch");
  return { detail: structuredClone(detail), content: content ? structuredClone(content) : null };
}
export type SiteListProps = SiteScope & {
  status?: "active" | "archived";
  onOpen: (site: WorkspaceArtifact) => void;
};
export type SiteDetailProps = SiteScope & {
  siteId: string;
  /** Presentation hint only: the backend still enforces artifacts:publish. */
  canPublish?: boolean;
  toolBridge?: PublishedHtmlArtifactToolBridge;
};

function useScopeKey(values: readonly unknown[]) {
  const [scope, setScope] = useState(values);
  const [generation, setGeneration] = useState(0);
  if (values.some((value, index) => value !== scope[index])) {
    setScope(values);
    setGeneration(generation + 1);
  }
  return generation;
}

export function SiteList(props: SiteListProps) {
  const key = useScopeKey([props.client, props.workspaceId, props.status]);
  return <ScopedSiteList key={key} {...props} />;
}
function ScopedSiteList({
  client,
  workspaceId,
  status = "active",
  onOpen,
  className,
}: SiteListProps) {
  const [page, setPage] = useState<WorkspaceArtifactListResponse | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setPage(null);
    setError(false);
    void Promise.resolve()
      .then(() =>
        client.listWorkspaceArtifacts(workspaceId, {
          status,
          ...(cursor ? { cursor } : {}),
          limit: 50,
          signal: abort.signal,
        }),
      )
      .then((result) => {
        if (!abort.signal.aborted) setPage(structuredClone(result));
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [client, workspaceId, status, cursor, reload]);
  return (
    <section className={className} aria-label="Sites" aria-busy={!page && !error}>
      {error ? (
        <p role="alert">Sites are unavailable or access has changed. Refresh to check access.</p>
      ) : !page ? (
        <p role="status">Loading Sites…</p>
      ) : page.artifacts.length === 0 ? (
        <p role="status">No {status} Sites.</p>
      ) : (
        <ul>
          {page.artifacts.map((site) => (
            <li key={site.id}>
              <button type="button" onClick={() => onOpen(structuredClone(site))}>
                {site.title}
              </button>
              <p>{site.description}</p>
              <span>
                {site.status} · revision {site.currentVersion?.revision ?? "unpublished"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {page?.nextCursor && (
        <button type="button" onClick={() => setCursor(page.nextCursor!)}>
          Next page
        </button>
      )}
      {cursor && (
        <button type="button" onClick={() => setCursor(undefined)}>
          First page
        </button>
      )}
      <button type="button" onClick={() => setReload((value) => value + 1)}>
        Refresh Sites
      </button>
    </section>
  );
}

export function SiteDetail(props: SiteDetailProps) {
  const key = useScopeKey([props.client, props.workspaceId, props.siteId]);
  return <ScopedSiteDetail key={key} {...props} />;
}
function ScopedSiteDetail({
  client,
  workspaceId,
  siteId,
  canPublish = false,
  toolBridge,
  className,
}: SiteDetailProps) {
  const [loaded, setLoaded] = useState<{
    detail: WorkspaceArtifactDetailResponse;
    content: SiteDisplayContent | null;
  } | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rollbackId, setRollbackId] = useState("");
  const [confirmation, setConfirmation] = useState<"status" | "rollback" | null>(null);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    setLoaded(null);
    setError(false);
    setConfirmation(null);
    setRollbackId("");
    void Promise.resolve()
      .then(async () => {
        const snapshot = await loadSiteSnapshot(client, workspaceId, siteId, {
          signal: abort.signal,
        });
        if (!abort.signal.aborted) setLoaded(snapshot);
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setLoaded(null);
          setError(true);
        }
      });
    return () => abort.abort();
  }, [client, workspaceId, siteId, reload]);
  // Recheck live read authority without rebuilding the iframe on every tick.
  // No overlapping polls, and failures remove the document and tool bridge.
  useEffect(() => {
    if (!loaded || busy) return;
    const abort = new AbortController();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void Promise.resolve()
        .then(() => client.getWorkspaceArtifact(workspaceId, siteId, { signal: abort.signal }))
        .then((detail) => {
          if (abort.signal.aborted) return;
          if (detail.artifact.id !== siteId || detail.artifact.workspaceId !== workspaceId)
            throw new Error("Site scope mismatch");
          if (
            detail.artifact.currentVersion?.id !== loaded.detail.artifact.currentVersion?.id ||
            detail.artifact.status !== loaded.detail.artifact.status
          ) {
            setLoaded(null);
            setReload((value) => value + 1);
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            setLoaded(null);
            setError(true);
          }
        })
        .finally(() => {
          checking = false;
        });
    }, 15_000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [client, workspaceId, siteId, loaded, busy]);
  const commit = async () => {
    const current = loaded?.detail.artifact.currentVersion;
    if (!canPublish || !loaded || !current || !confirmation || mutation.current) return;
    const abort = new AbortController();
    mutation.current = abort;
    setBusy(true);
    try {
      const common = { expectedCurrentVersionId: current.id, idempotencyKey: crypto.randomUUID() };
      if (confirmation === "rollback") {
        if (!loaded.detail.versions.some((version) => version.id === rollbackId))
          throw new Error("Unknown version");
        await client.rollbackWorkspaceArtifact(
          workspaceId,
          siteId,
          { ...common, versionId: rollbackId, reason: "Restore explicitly selected Site version" },
          { signal: abort.signal },
        );
      } else {
        await client.setWorkspaceArtifactStatus(
          workspaceId,
          siteId,
          {
            ...common,
            status: loaded.detail.artifact.status === "active" ? "archived" : "active",
            reason: "Explicit Site status change",
          },
          { signal: abort.signal },
        );
      }
      if (!abort.signal.aborted) {
        setLoaded(null);
        setReload((value) => value + 1);
      }
    } catch {
      if (!abort.signal.aborted) {
        setLoaded(null);
        setError(true);
      }
    } finally {
      if (!abort.signal.aborted) {
        mutation.current = null;
        setBusy(false);
        setConfirmation(null);
      }
    }
  };
  const site = loaded?.detail.artifact;
  return (
    <section
      className={className}
      aria-label="Site details"
      aria-busy={busy || (!loaded && !error)}
    >
      {error && (
        <p role="alert">
          Site state could not be confirmed or access has changed. Refresh before continuing.
        </p>
      )}
      {!loaded && !error && <p role="status">Loading Site…</p>}
      {site && (
        <>
          <h2>{site.title}</h2>
          <p>{site.description}</p>
          <p>
            {site.status} · revision {site.currentVersion?.revision ?? "unpublished"}
          </p>
          {loaded.content && (
            <PublishedHtmlArtifactFrame
              html={loaded.content.html}
              title={site.title}
              {...(toolBridge ? { toolBridge } : {})}
            />
          )}
          <h3>Versions</h3>
          <ul>
            {loaded.detail.versions.map((version) => (
              <li key={version.id}>
                Revision {version.revision} · {version.createdAt}
                {version.id === site.currentVersion?.id ? " · current" : ""}
              </li>
            ))}
          </ul>
          {loaded.detail.versionsTruncated && (
            <p>Older versions are not included in this response.</p>
          )}
          {canPublish && site.currentVersion && (
            <fieldset disabled={busy}>
              <legend>Manage Site</legend>
              <button type="button" onClick={() => setConfirmation("status")}>
                {site.status === "active" ? "Archive Site" : "Restore Site"}
              </button>
              <label>
                Version to restore
                <select
                  value={rollbackId}
                  onChange={(event) => {
                    setRollbackId(event.target.value);
                    setConfirmation(null);
                  }}
                >
                  <option value="">Choose a version</option>
                  {loaded.detail.versions
                    .filter((version) => version.id !== site.currentVersion?.id)
                    .map((version) => (
                      <option key={version.id} value={version.id}>
                        Revision {version.revision}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!rollbackId}
                onClick={() => setConfirmation("rollback")}
              >
                Review rollback
              </button>
              {confirmation && (
                <div role="group" aria-label="Confirm Site change">
                  <p>
                    {confirmation === "rollback"
                      ? "Make the selected version current?"
                      : site.status === "active"
                        ? "Archive this Site for workspace users?"
                        : "Restore this Site for workspace users?"}
                  </p>
                  <button type="button" onClick={() => void commit()}>
                    Confirm change
                  </button>
                  <button type="button" onClick={() => setConfirmation(null)}>
                    Keep current state
                  </button>
                </div>
              )}
            </fieldset>
          )}
        </>
      )}
      <button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>
        Refresh Site
      </button>
    </section>
  );
}
