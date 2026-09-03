import type {
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactVersion,
} from "@opengeni/contracts";

type ArtifactProvenance = {
  sourceSessionId: string | null;
  sourceTurnId: string | null;
  sourceAttemptId: string | null;
  sourceExecutionGeneration: number | null;
};

type CanReadSession = (sessionId: string) => Promise<boolean>;

function redactProvenance<Value extends ArtifactProvenance>(value: Value): Value {
  return {
    ...value,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
  };
}

export function redactWorkspaceArtifactListProvenance(
  response: WorkspaceArtifactListResponse,
): WorkspaceArtifactListResponse {
  return {
    ...response,
    artifacts: response.artifacts.map((artifact) => ({
      ...artifact,
      currentVersion: artifact.currentVersion ? redactProvenance(artifact.currentVersion) : null,
    })),
  };
}

export async function projectWorkspaceArtifactVersionProvenance(
  version: WorkspaceArtifactVersion,
  canReadSession: CanReadSession,
): Promise<WorkspaceArtifactVersion> {
  if (!version.sourceSessionId || (await canReadSession(version.sourceSessionId))) return version;
  return redactProvenance(version);
}

export async function projectWorkspaceArtifactDetailProvenance(
  detail: WorkspaceArtifactDetailResponse,
  canReadSession: CanReadSession,
): Promise<WorkspaceArtifactDetailResponse> {
  const decisions = new Map<string, Promise<boolean>>();
  const canRead = (sessionId: string): Promise<boolean> => {
    const existing = decisions.get(sessionId);
    if (existing) return existing;
    const decision = canReadSession(sessionId);
    decisions.set(sessionId, decision);
    return decision;
  };
  const project = async <Value extends ArtifactProvenance>(value: Value): Promise<Value> => {
    if (!value.sourceSessionId || (await canRead(value.sourceSessionId))) return value;
    return redactProvenance(value);
  };
  const [currentVersion, versions, events] = await Promise.all([
    detail.artifact.currentVersion ? project(detail.artifact.currentVersion) : null,
    Promise.all(detail.versions.map(project)),
    Promise.all(detail.events.map(project)),
  ]);
  return {
    ...detail,
    artifact: { ...detail.artifact, currentVersion },
    versions,
    events,
  };
}
