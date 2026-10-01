import { ArtifactSessionPage } from "@/components/session/artifact-session-page";
import { editableArtifactKernelRuntime as documentRuntime } from "@opengeni/artifact-kernel-wasm-document";
import { editableArtifactKernelRuntime as presentationRuntime } from "@opengeni/artifact-kernel-wasm-presentation";
import { editableArtifactKernelRuntime as spreadsheetRuntime } from "@opengeni/artifact-kernel-wasm-spreadsheet";
import {
  EditableArtifactView,
  artifactLoadErrorView,
  type ArtifactLoadErrorView,
  type OpenedEditableArtifact,
} from "@opengeni/react/artifacts";
import type { AccessContext, Workspace } from "@opengeni/sdk";
// Vite turns this public SDK Worker entry into a deployment-owned module URL.
// oxlint-disable-next-line import/default
import artifactWorkerUrl from "@opengeni/sdk/editable-artifacts/worker?worker&url";

import { apiBaseUrl, authHeadersForAccessKey, getStoredAccessKey } from "@/api";
import { useAppContext } from "@/context";
import { ARTIFACT_ACCESS_REQUIRED, isArtifactReadDenied } from "@/lib/artifact-access";
import {
  createConsoleEditableArtifactReplicaId,
  createConsoleEditableArtifactAuthority,
  resolveConsoleEditableArtifactWorkerUrl,
} from "@/lib/editable-artifact-browser";
import { editableArtifactClient } from "@/lib/editable-artifact-client";

const absoluteApiBaseUrl = new URL(apiBaseUrl || "/", window.location.origin);

/** First-party consumer of the exact public SDK/React editable-artifact API. */
export function EditableArtifactRoute({
  fromSession,
  embedded = false,
  ...params
}: Readonly<{
  workspaceId: string;
  artifactId: string;
  fromSession?: string | undefined;
  embedded?: boolean;
}>) {
  if (embedded) return <EditableArtifactContent {...params} embedded />;
  return (
    <ArtifactSessionPage
      workspaceId={params.workspaceId}
      fromSession={fromSession}
      showAllArtifacts
    >
      <EditableArtifactContent {...params} />
    </ArtifactSessionPage>
  );
}

function EditableArtifactContent({
  workspaceId,
  artifactId,
  embedded = false,
}: Readonly<{ workspaceId: string; artifactId: string; embedded?: boolean }>) {
  const context = useAppContext();
  const insecureLoopback =
    absoluteApiBaseUrl.protocol === "http:" && isLoopbackHost(absoluteApiBaseUrl.hostname);
  const headers = authHeadersForAccessKey(getStoredAccessKey());
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  return (
    <div data-workspace-scroll-owner="self-managed" className="h-full min-h-0">
      <EditableArtifactView
        baseUrl={absoluteApiBaseUrl}
        workspaceId={workspaceId}
        artifactId={artifactId}
        authorityKey={JSON.stringify([
          context.accessKeyVersion,
          workspace?.accountId ?? null,
          context.accessContext,
        ])}
        showHeader={!embedded}
        describeError={(error): ArtifactLoadErrorView =>
          isArtifactReadDenied(error, context.accessContext, workspaceId)
            ? {
                title: "You can't open this artifact",
                message: ARTIFACT_ACCESS_REQUIRED,
                retryable: false,
              }
            : artifactLoadErrorView(error, "editable")
        }
        open={() =>
          loadArtifact({
            workspaceId,
            artifactId,
            accessKeyVersion: context.accessKeyVersion,
            accessContext: context.accessContext,
            workspace,
          })
        }
        runtimes={{
          document: documentRuntime,
          spreadsheet: spreadsheetRuntime,
          presentation: presentationRuntime,
          workerUrl: resolveConsoleEditableArtifactWorkerUrl(
            artifactWorkerUrl,
            window.location.origin,
          ),
          applicationOrigin: window.location.origin,
          ...(insecureLoopback ? { allowInsecureDevelopmentAssets: true } : {}),
        }}
        transport={{
          credentials: "include",
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(insecureLoopback ? { allowInsecureDevelopmentTransport: true } : {}),
        }}
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
): Promise<OpenedEditableArtifact> {
  const authority = await createConsoleEditableArtifactAuthority({
    deploymentOrigin: absoluteApiBaseUrl.origin,
    workspace: input.workspace,
    accessContext: input.accessContext,
    accessKeyVersion: input.accessKeyVersion,
  });
  const replicaId = createConsoleEditableArtifactReplicaId();
  const artifact = await editableArtifactClient.getEditableArtifact(
    input.workspaceId,
    input.artifactId,
    { replicaId },
  );
  return Object.freeze({ artifact, authority, replicaId });
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
