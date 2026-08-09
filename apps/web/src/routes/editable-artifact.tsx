import { editableArtifactKernelRuntime as documentRuntime } from "@opengeni/artifact-kernel-wasm-document";
import { editableArtifactKernelRuntime as presentationRuntime } from "@opengeni/artifact-kernel-wasm-presentation";
import { editableArtifactKernelRuntime as spreadsheetRuntime } from "@opengeni/artifact-kernel-wasm-spreadsheet";
import { BrowserEditableArtifactWorkbench } from "@opengeni/react/artifacts";
import type { AccessContext, Workspace } from "@opengeni/sdk";
import { OpenGeniClient, type EditableArtifactResource } from "@opengeni/sdk/artifacts";
import {
  type EditableArtifactBrowserRuntime,
  type EditableArtifactCacheAuthority,
  type EditableArtifactModality,
} from "@opengeni/sdk/editable-artifacts";
// Vite turns this public SDK Worker entry into a deployment-owned module URL.
// oxlint-disable-next-line import/default
import artifactWorkerUrl from "@opengeni/sdk/editable-artifacts/worker?worker&url";
import { useEffect, useState } from "react";

import { apiBaseUrl, authHeadersForAccessKey, getStoredAccessKey } from "@/api";
import { LoadingPanel, ProblemPanel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import {
  createConsoleEditableArtifactReplicaId,
  createConsoleEditableArtifactAuthority,
} from "@/lib/editable-artifact-browser";

type OpenArtifact = Readonly<{
  artifact: EditableArtifactResource;
  authority: EditableArtifactCacheAuthority;
  replicaId: string;
}>;

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; value: OpenArtifact }>
  | Readonly<{ kind: "error"; error: Error }>;

const absoluteApiBaseUrl = new URL(apiBaseUrl || "/", window.location.origin);
const artifactClient = new OpenGeniClient({
  baseUrl: apiBaseUrl,
  headers: () => authHeadersForAccessKey(getStoredAccessKey()),
  fetch: (input, init) => fetch(input, { ...init, credentials: init?.credentials ?? "include" }),
});

/** First-party consumer of the exact public SDK/React editable-artifact API. */
export function EditableArtifactRoute({
  workspaceId,
  artifactId,
}: Readonly<{ workspaceId: string; artifactId: string }>) {
  const context = useAppContext();
  const [loadEpoch, setLoadEpoch] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void loadArtifact({
      workspaceId,
      artifactId,
      accessKeyVersion: context.accessKeyVersion,
      accessContext: context.accessContext,
      workspace: context.workspaces.find((candidate) => candidate.id === workspaceId),
    })
      .then((value) => {
        if (current) setState({ kind: "ready", value });
      })
      .catch((cause: unknown) => {
        if (current) setState({ kind: "error", error: asError(cause) });
      });
    return () => {
      current = false;
    };
  }, [
    artifactId,
    context.accessContext,
    context.accessKeyVersion,
    context.workspaces,
    loadEpoch,
    workspaceId,
  ]);

  if (state.kind === "loading") {
    return <LoadingPanel label="Opening artifact" />;
  }
  if (state.kind === "error") {
    return (
      <ProblemPanel
        title="Could not open this artifact"
        description={state.error.message}
        action={
          <Button
            type="button"
            variant="secondary"
            onClick={() => setLoadEpoch((value) => value + 1)}
          >
            Try again
          </Button>
        }
      />
    );
  }

  const { artifact, authority, replicaId } = state.value;
  const runtime = runtimeFor(artifact.modality);
  const insecureLoopback =
    absoluteApiBaseUrl.protocol === "http:" && isLoopbackHost(absoluteApiBaseUrl.hostname);
  const headers = authHeadersForAccessKey(getStoredAccessKey());
  return (
    <div className="h-full min-h-0 bg-og-bg text-og-fg">
      <BrowserEditableArtifactWorkbench
        options={{
          baseUrl: absoluteApiBaseUrl,
          workspaceId,
          artifact,
          storageAuthority: authority,
          replicaId,
          runtime: {
            ...runtime,
            workerUrl: artifactWorkerUrl,
            applicationOrigin: window.location.origin,
            ...(insecureLoopback ? { allowInsecureDevelopmentAssets: true } : {}),
          },
          transport: {
            credentials: "include",
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
            ...(insecureLoopback ? { allowInsecureDevelopmentTransport: true } : {}),
          },
        }}
        document={{ title: artifact.title }}
        spreadsheet={{ title: artifact.title }}
        presentation={{ title: artifact.title }}
      />
    </div>
  );
}

async function loadArtifact(
  input: Readonly<{
    workspaceId: string;
    artifactId: string;
    accessKeyVersion: number;
    accessContext: AccessContext;
    workspace: Workspace | undefined;
  }>,
): Promise<OpenArtifact> {
  const authority = await createConsoleEditableArtifactAuthority({
    deploymentOrigin: absoluteApiBaseUrl.origin,
    workspace: input.workspace,
    accessContext: input.accessContext,
    accessKeyVersion: input.accessKeyVersion,
  });
  const replicaId = createConsoleEditableArtifactReplicaId();
  const artifact = await artifactClient.getEditableArtifact(input.workspaceId, input.artifactId, {
    replicaId,
  });
  return Object.freeze({ artifact, authority, replicaId });
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

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Unknown artifact error");
}
