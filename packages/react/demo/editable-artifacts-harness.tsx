import { editableArtifactKernelRuntime as documentRuntime } from "@opengeni/artifact-kernel-wasm-document";
import { editableArtifactKernelRuntime as presentationRuntime } from "@opengeni/artifact-kernel-wasm-presentation";
import { editableArtifactKernelRuntime as spreadsheetRuntime } from "@opengeni/artifact-kernel-wasm-spreadsheet";
import type { AccessContext, Workspace } from "@opengeni/sdk";
import { OpenGeniClient, type EditableArtifactResource } from "@opengeni/sdk/artifacts";
import {
  createEditableArtifactReplicaId,
  type EditableArtifactBrowserRuntime,
  type EditableArtifactCacheAuthority,
  type EditableArtifactModality,
} from "@opengeni/sdk/editable-artifacts";
// Vite's `?worker&url` transform synthesizes this default URL export.
// oxlint-disable-next-line import/default
import artifactWorkerUrl from "@opengeni/sdk/editable-artifacts/worker?worker&url";
import { BrowserEditableArtifactWorkbench } from "@opengeni/react/artifacts";
import {
  ArrowRightIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PresentationIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const apiBaseUrl = import.meta.env.VITE_OPENGENI_DEMO_API_BASE_URL ?? "/demo-api";
const absoluteApiBaseUrl = new URL(apiBaseUrl, location.origin);
const client = new OpenGeniClient({
  baseUrl: apiBaseUrl,
  fetch: (input, init) => fetch(input, { ...init, credentials: init?.credentials ?? "include" }),
});
const initialLocation = readLocation();

type WorkspaceAuthority = Readonly<{
  access: AccessContext;
  workspace: Workspace;
  cacheAuthority: EditableArtifactCacheAuthority;
}>;

type LoadedArtifact = WorkspaceAuthority &
  Readonly<{
    artifact: EditableArtifactResource;
    replicaId: string;
  }>;

type LoadState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "workspace"; value: WorkspaceAuthority }>
  | Readonly<{ kind: "artifact"; value: LoadedArtifact }>
  | Readonly<{ kind: "error"; error: Error }>;

function EditableArtifactReferenceConsumer() {
  const [workspaceId, setWorkspaceId] = useState(initialLocation.workspaceId);
  const [artifactId, setArtifactId] = useState(initialLocation.artifactId);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const [state, setState] = useState<LoadState>(
    initialLocation.workspaceId ? { kind: "loading" } : { kind: "idle" },
  );

  useEffect(() => {
    if (!workspaceId) {
      setState({ kind: "idle" });
      return;
    }
    let current = true;
    setState({ kind: "loading" });
    void loadWorkspaceAuthority(workspaceId)
      .then(async (authority) => {
        if (!artifactId) return { kind: "workspace", value: authority } as const;
        const replicaId = getOrCreateReplicaId(authority.cacheAuthority, artifactId);
        const artifact = await client.getEditableArtifact(workspaceId, artifactId, { replicaId });
        return {
          kind: "artifact",
          value: { ...authority, artifact, replicaId },
        } as const;
      })
      .then((next) => {
        if (current) setState(next);
      })
      .catch((cause) => {
        if (current) setState({ kind: "error", error: asError(cause) });
      });
    return () => {
      current = false;
    };
  }, [artifactId, loadEpoch, workspaceId]);

  const navigate = useCallback((nextWorkspaceId: string, nextArtifactId: string) => {
    const normalizedWorkspaceId = nextWorkspaceId.trim();
    const normalizedArtifactId = nextArtifactId.trim().toLowerCase();
    writeLocation(normalizedWorkspaceId, normalizedArtifactId);
    setWorkspaceId(normalizedWorkspaceId);
    setArtifactId(normalizedArtifactId);
  }, []);

  if (state.kind === "idle") {
    return <WorkspaceSetup onOpen={navigate} />;
  }
  if (state.kind === "loading") {
    return <CenteredStatus title="Opening artifact workspace" detail="Checking access…" />;
  }
  if (state.kind === "error") {
    return (
      <CenteredStatus
        title="Could not open artifacts"
        detail={state.error.message}
        action={
          <button
            type="button"
            className="og-artifact-primary"
            onClick={() => setLoadEpoch((v) => v + 1)}
          >
            <RefreshCwIcon aria-hidden="true" size={15} />
            Try again
          </button>
        }
      />
    );
  }
  if (state.kind === "workspace") {
    return (
      <ArtifactStart
        authority={state.value}
        onOpen={(nextArtifactId) => navigate(workspaceId, nextArtifactId)}
      />
    );
  }
  return <LiveArtifact value={state.value} />;
}

function LiveArtifact({ value }: Readonly<{ value: LoadedArtifact }>) {
  const runtime = runtimeFor(value.artifact.modality);
  const isInsecureLoopback =
    absoluteApiBaseUrl.protocol === "http:" && isLoopbackHost(absoluteApiBaseUrl.hostname);

  return (
    <main className="og-root h-dvh min-h-0 bg-og-bg text-og-fg">
      <BrowserEditableArtifactWorkbench
        options={{
          baseUrl: absoluteApiBaseUrl,
          workspaceId: value.workspace.id,
          artifact: value.artifact,
          storageAuthority: value.cacheAuthority,
          replicaId: value.replicaId,
          runtime: {
            ...runtime,
            workerUrl: new URL(artifactWorkerUrl, location.origin),
            applicationOrigin: location.origin,
            ...(isInsecureLoopback ? { allowInsecureDevelopmentAssets: true } : {}),
          },
          transport: {
            credentials: "include",
            ...(isInsecureLoopback ? { allowInsecureDevelopmentTransport: true } : {}),
          },
        }}
        document={{ title: value.artifact.title }}
        spreadsheet={{ title: value.artifact.title }}
        presentation={{ title: value.artifact.title }}
      />
    </main>
  );
}

function ArtifactStart({
  authority,
  onOpen,
}: Readonly<{
  authority: WorkspaceAuthority;
  onOpen: (artifactId: string) => void;
}>) {
  const [title, setTitle] = useState("Untitled document");
  const [modality, setModality] = useState<EditableArtifactModality>("document");
  const [existingId, setExistingId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef<
    Readonly<{ fingerprint: string; idempotencyKey: string; replicaId: string }> | undefined
  >(undefined);

  const createArtifact = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle || creating) return;
    if (new TextEncoder().encode(normalizedTitle).byteLength > 512) {
      setError("Artifact titles must be at most 512 UTF-8 bytes.");
      return;
    }
    const fingerprint = JSON.stringify([modality, normalizedTitle]);
    if (attemptRef.current?.fingerprint !== fingerprint) {
      attemptRef.current = {
        fingerprint,
        idempotencyKey: `react-artifact-demo:${crypto.randomUUID()}`,
        replicaId: createEditableArtifactReplicaId(),
      };
    }
    const attempt = attemptRef.current!;
    setCreating(true);
    setError(null);
    try {
      assertBrowserStorage();
      const artifact = await client.createEditableArtifact(authority.workspace.id, {
        modality,
        title: normalizedTitle,
        idempotencyKey: attempt.idempotencyKey,
        replicaId: attempt.replicaId,
      });
      storeReplicaId(authority.cacheAuthority, artifact.id, attempt.replicaId);
      attemptRef.current = undefined;
      onOpen(artifact.id);
    } catch (cause) {
      setError(asError(cause).message);
    } finally {
      setCreating(false);
    }
  };

  const openExisting = (event: FormEvent) => {
    event.preventDefault();
    const normalized = existingId.trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/u.test(normalized) || /^0+$/u.test(normalized)) {
      setError("Artifact ID must be the 32-character hexadecimal ID from OpenGeni.");
      return;
    }
    setError(null);
    onOpen(normalized);
  };

  const selected = modalityOptions.find((option) => option.modality === modality)!;
  return (
    <main className="og-root min-h-dvh bg-og-bg px-5 py-10 text-og-fg sm:px-8 sm:py-16">
      <div className="mx-auto max-w-4xl">
        <p className="text-og-xs font-medium uppercase tracking-[0.14em] text-og-fg-subtle">
          {authority.workspace.name}
        </p>
        <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Create something worth keeping.
        </h1>
        <p className="mt-3 max-w-xl text-og-sm leading-6 text-og-fg-muted">
          Native document, spreadsheet, and presentation editing through the public OpenGeni SDK.
        </p>

        <form onSubmit={createArtifact} className="mt-10 space-y-5">
          <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Artifact type">
            {modalityOptions.map((option) => {
              const Icon = option.icon;
              const active = modality === option.modality;
              return (
                <button
                  key={option.modality}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setModality(option.modality);
                    setTitle(option.defaultTitle);
                    setError(null);
                  }}
                  className={`group rounded-og-xl border p-4 text-left transition ${
                    active
                      ? "border-og-accent/60 bg-og-accent/10 shadow-og-sm"
                      : "border-og-border bg-og-surface-1 hover:border-og-border-strong hover:bg-og-surface-2"
                  }`}
                >
                  <span
                    className={`flex size-9 items-center justify-center rounded-og-lg ${
                      active ? "bg-og-accent text-white" : "bg-og-surface-3 text-og-fg-muted"
                    }`}
                  >
                    <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
                  </span>
                  <span className="mt-4 block text-og-sm font-medium">{option.label}</span>
                  <span className="mt-1 block text-og-xs leading-5 text-og-fg-subtle">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-3 rounded-og-xl border border-og-border bg-og-surface-1 p-3 sm:flex-row">
            <label className="sr-only" htmlFor="artifact-title">
              Artifact title
            </label>
            <input
              id="artifact-title"
              value={title}
              maxLength={512}
              autoComplete="off"
              onChange={(event) => {
                setTitle(event.target.value);
                setError(null);
              }}
              className="min-h-10 min-w-0 flex-1 bg-transparent px-2 text-og-sm outline-none placeholder:text-og-fg-subtle"
              placeholder={selected.defaultTitle}
            />
            <button
              type="submit"
              className="og-artifact-primary"
              disabled={creating || !title.trim()}
            >
              {creating ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" size={16} />
              ) : (
                <selected.icon aria-hidden="true" size={16} />
              )}
              {creating ? "Creating…" : `Create ${selected.label.toLowerCase()}`}
            </button>
          </div>
        </form>

        <div className="my-9 flex items-center gap-4 text-og-xs text-og-fg-subtle">
          <span className="h-px flex-1 bg-og-border" />
          Open an existing artifact
          <span className="h-px flex-1 bg-og-border" />
        </div>
        <form onSubmit={openExisting} className="flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="existing-artifact-id">
            Artifact ID
          </label>
          <input
            id="existing-artifact-id"
            value={existingId}
            onChange={(event) => {
              setExistingId(event.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            className="min-h-10 min-w-0 flex-1 rounded-og-lg border border-og-border bg-og-surface-1 px-3 font-og-mono text-og-xs outline-none transition focus:border-og-accent/60"
            placeholder="32-character artifact ID"
          />
          <button type="submit" className="og-artifact-secondary">
            Open
            <ArrowRightIcon aria-hidden="true" size={15} />
          </button>
        </form>
        {error ? (
          <p role="alert" className="mt-4 text-og-xs text-og-danger">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}

function WorkspaceSetup({
  onOpen,
}: Readonly<{ onOpen: (workspaceId: string, artifactId: string) => void }>) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [artifactId, setArtifactId] = useState("");
  return (
    <main className="og-root flex min-h-dvh items-center justify-center bg-og-bg p-5 text-og-fg">
      <form
        className="w-full max-w-lg rounded-og-xl border border-og-border bg-og-surface-1 p-6 shadow-og-lg sm:p-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (workspaceId.trim()) onOpen(workspaceId, artifactId);
        }}
      >
        <p className="text-og-xs font-medium uppercase tracking-[0.14em] text-og-fg-subtle">
          Public reference consumer
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Editable artifacts</h1>
        <p className="mt-2 text-og-sm leading-6 text-og-fg-muted">
          Connect this live SDK demo to an authenticated OpenGeni workspace.
        </p>
        <div className="mt-7 space-y-4">
          <label className="block text-og-xs font-medium" htmlFor="workspace-id">
            Workspace ID
          </label>
          <input
            id="workspace-id"
            required
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            className="min-h-10 w-full rounded-og-lg border border-og-border bg-og-bg px-3 font-og-mono text-og-xs outline-none transition focus:border-og-accent/60"
            placeholder="Workspace UUID"
          />
          <label className="block text-og-xs font-medium" htmlFor="optional-artifact-id">
            Artifact ID <span className="font-normal text-og-fg-subtle">(optional)</span>
          </label>
          <input
            id="optional-artifact-id"
            value={artifactId}
            onChange={(event) => setArtifactId(event.target.value)}
            className="min-h-10 w-full rounded-og-lg border border-og-border bg-og-bg px-3 font-og-mono text-og-xs outline-none transition focus:border-og-accent/60"
            placeholder="Leave empty to create one"
          />
        </div>
        <button type="submit" className="og-artifact-primary mt-6 w-full">
          Continue
          <ArrowRightIcon aria-hidden="true" size={15} />
        </button>
      </form>
    </main>
  );
}

function CenteredStatus({
  title,
  detail,
  action,
}: Readonly<{ title: string; detail: string; action?: ReactNode }>) {
  return (
    <main className="og-root flex min-h-dvh items-center justify-center bg-og-bg p-5 text-og-fg">
      <div className="max-w-md text-center">
        {!action ? (
          <LoaderCircleIcon
            className="mx-auto animate-spin text-og-fg-subtle"
            aria-hidden="true"
            size={20}
          />
        ) : null}
        <h1 className="mt-4 text-og-base font-medium">{title}</h1>
        <p className="mt-2 text-og-xs leading-5 text-og-fg-muted">{detail}</p>
        {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
      </div>
    </main>
  );
}

async function loadWorkspaceAuthority(workspaceId: string): Promise<WorkspaceAuthority> {
  const [access, workspace] = await Promise.all([
    client.getAccessContext(),
    client.getWorkspace(workspaceId),
  ]);
  const grant = access.workspaceGrants.find((candidate) => candidate.workspaceId === workspace.id);
  if (!grant || grant.accountId !== workspace.accountId || grant.subjectId !== access.subjectId) {
    throw new Error("Your current login does not grant access to this workspace.");
  }
  const accountGrant = access.accountGrants.find(
    (candidate) =>
      candidate.accountId === workspace.accountId && candidate.subjectId === access.subjectId,
  );
  const authorizationEpoch = await sha256(
    JSON.stringify({
      mode: access.mode,
      subjectId: access.subjectId,
      workspace: {
        accountId: grant.accountId,
        permissions: [...grant.permissions].sort(),
        principalKind: grant.principalKind ?? null,
      },
      account: accountGrant
        ? { role: accountGrant.role ?? null, permissions: [...accountGrant.permissions].sort() }
        : null,
    }),
  );
  return {
    access,
    workspace,
    cacheAuthority: {
      deploymentOrigin: absoluteApiBaseUrl.origin,
      accountId: workspace.accountId,
      workspaceId: workspace.id,
      principalId: access.subjectId,
      authorizationEpoch,
    },
  };
}

function runtimeFor(
  modality: EditableArtifactModality,
): Omit<EditableArtifactBrowserRuntime, "workerUrl"> {
  switch (modality) {
    case "document":
      return documentRuntime;
    case "spreadsheet":
      return spreadsheetRuntime;
    case "presentation":
      return presentationRuntime;
  }
}

function readLocation(): Readonly<{ workspaceId: string; artifactId: string }> {
  const params = new URLSearchParams(location.search);
  return {
    workspaceId: params.get("workspaceId")?.trim() ?? "",
    artifactId: params.get("artifactId")?.trim().toLowerCase() ?? "",
  };
}

function writeLocation(workspaceId: string, artifactId: string): void {
  const url = new URL(location.href);
  if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
  else url.searchParams.delete("workspaceId");
  if (artifactId) url.searchParams.set("artifactId", artifactId);
  else url.searchParams.delete("artifactId");
  history.replaceState(null, "", url);
}

function replicaStorageKey(authority: EditableArtifactCacheAuthority, artifactId: string): string {
  return `opengeni:editable-artifact-replica:v1:${JSON.stringify([
    authority.deploymentOrigin,
    authority.accountId,
    authority.workspaceId,
    authority.principalId,
    artifactId,
  ])}`;
}

function getOrCreateReplicaId(
  authority: EditableArtifactCacheAuthority,
  artifactId: string,
): string {
  assertBrowserStorage();
  const key = replicaStorageKey(authority, artifactId);
  const existing = localStorage.getItem(key);
  if (existing && /^[0-9a-f]{16}$/u.test(existing) && !/^0+$/u.test(existing)) return existing;
  const replicaId = createEditableArtifactReplicaId();
  localStorage.setItem(key, replicaId);
  return replicaId;
}

function storeReplicaId(
  authority: EditableArtifactCacheAuthority,
  artifactId: string,
  replicaId: string,
): void {
  assertBrowserStorage();
  localStorage.setItem(replicaStorageKey(authority, artifactId), replicaId);
}

function assertBrowserStorage(): void {
  const key = "opengeni:editable-artifact-storage-check";
  try {
    localStorage.setItem(key, "1");
    localStorage.removeItem(key);
  } catch {
    throw new Error("Browser storage is required for durable offline editing.");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Unknown artifact error");
}

const modalityOptions = [
  {
    modality: "document",
    label: "Document",
    defaultTitle: "Untitled document",
    description: "Structured writing, review, and rich text.",
    icon: FileTextIcon,
  },
  {
    modality: "spreadsheet",
    label: "Spreadsheet",
    defaultTitle: "Untitled spreadsheet",
    description: "Fast formulas, large sheets, and collaboration.",
    icon: FileSpreadsheetIcon,
  },
  {
    modality: "presentation",
    label: "Presentation",
    defaultTitle: "Untitled presentation",
    description: "Slides, layouts, and precise visual composition.",
    icon: PresentationIcon,
  },
] as const;

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
const hotData = import.meta.hot?.data as
  | { editableArtifactRoot?: ReturnType<typeof createRoot> }
  | undefined;
const reactRoot = hotData?.editableArtifactRoot ?? createRoot(root);
if (hotData) hotData.editableArtifactRoot = reactRoot;
reactRoot.render(<EditableArtifactReferenceConsumer />);
