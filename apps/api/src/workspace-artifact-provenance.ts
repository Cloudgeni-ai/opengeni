import type {
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
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

function artifactProvenanceProjector(canReadSession: CanReadSession) {
  const decisions = new Map<string, Promise<boolean>>();
  const canRead = (sessionId: string): Promise<boolean> => {
    const existing = decisions.get(sessionId);
    if (existing) return existing;
    const decision = canReadSession(sessionId);
    decisions.set(sessionId, decision);
    return decision;
  };
  return async <Value extends ArtifactProvenance>(value: Value): Promise<Value> => {
    if (!value.sourceSessionId || (await canRead(value.sourceSessionId))) return value;
    return redactProvenance(value);
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
  return await artifactProvenanceProjector(canReadSession)(version);
}

export async function projectWorkspaceArtifactDetailProvenance(
  detail: WorkspaceArtifactDetailResponse,
  canReadSession: CanReadSession,
): Promise<WorkspaceArtifactDetailResponse> {
  const project = artifactProvenanceProjector(canReadSession);
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

export async function projectWorkspaceArtifactMutationProvenance(
  response: WorkspaceArtifactMutationResponse,
  canReadSession: CanReadSession,
): Promise<WorkspaceArtifactMutationResponse> {
  // The mutation is already durable before this response projection runs. A
  // transient source-session lookup must fail closed to redaction rather than
  // turn a committed, idempotent mutation into an ambiguous HTTP/tool error.
  const project = artifactProvenanceProjector(async (sessionId) => {
    try {
      return await canReadSession(sessionId);
    } catch {
      return false;
    }
  });
  const [currentVersion, version, event] = await Promise.all([
    response.artifact.currentVersion ? project(response.artifact.currentVersion) : null,
    project(response.version),
    project(response.event),
  ]);
  return {
    ...response,
    artifact: { ...response.artifact, currentVersion },
    version,
    event,
  };
}
