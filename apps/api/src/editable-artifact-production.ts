import { createHash, randomUUID } from "node:crypto";
import {
  editableArtifactMaterializerCapabilitiesForRuntime,
  type EditableArtifactNativeMaterializerCapabilities,
} from "@opengeni/artifact-tool/runtime/materializer";
import {
  EditableArtifactDurableExportService,
  EDITABLE_ARTIFACT_EXPORT_MAX_DOWNLOAD_BYTES,
  EditableArtifactCompactionPipeline,
  EditableArtifactGenesisPipeline,
  EditableArtifactService,
  MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES,
  ProductionEditableArtifactSnapshotVerifier,
  SystemEditableArtifactClock,
  editableArtifactLiveReadPortFromPostgres,
  editableArtifactLiveTicketStorePortFromPostgres,
  editableArtifactStorePortFromPostgres,
  editableArtifactDurableExportStorePortFromPostgres,
  ogatxEditableArtifactMutationIntentCodec,
  type EditableArtifactAuthorizationDecision,
  type EditableArtifactAuthorizationPort,
  type EditableArtifactAuthorizationRequest,
  type EditableArtifactStableIdFactoryPort,
  type EditableArtifactStableIdKind,
  type EditableArtifactDurableExportIdFactoryPort,
  type EditableArtifactExactSnapshotPort,
  type EditableArtifactMaterializationProfilePort,
} from "@opengeni/core/editable-artifacts";
import {
  EDITABLE_ARTIFACT_LIVE_PROTOCOL_VERSION,
  EditableArtifactApplication,
  EditableArtifactCompatibilityError,
  EditableArtifactLiveServer,
  SystemEditableArtifactLiveClock,
  SystemEditableArtifactLiveScheduler,
  WebCryptoEditableArtifactLiveTokens,
  type EditableArtifactApplicationPort,
  type EditableArtifactLiveAuthorizationInvalidationPort,
  type EditableArtifactLiveCompatibilityPort,
} from "@opengeni/core/editable-artifact-live";
import {
  PostgresEditableArtifactLiveReadStore,
  PostgresEditableArtifactLiveTicketStore,
  PostgresEditableArtifactStore,
  dbSql,
  withRlsContext,
  type Database,
  type PersistedEditableArtifactSnapshotBytesPort,
  type PersistedEditableArtifactSnapshotMetadata,
} from "@opengeni/db";
import { PostgresEditableArtifactDurableExportStore } from "@opengeni/db/editable-artifact-durable-export";
import type { EventBus } from "@opengeni/events";
import {
  MAX_BOUNDED_OBJECT_CHUNK_BYTES,
  createObjectStorageBoundedPorts,
  type BoundedObjectReadPort,
  type ObjectStorage,
} from "@opengeni/storage";
import { EventBusEditableArtifactLiveHints } from "./editable-artifact-live-hints";
import {
  NativeEditableArtifactKernelAdapter,
  loadVerifiedNativeArtifactRuntimeBinding,
} from "./editable-artifact-native-kernel";

const INVALIDATION_POLL_MS = 1_000;
const TICKET_CLEANUP_MS = 30_000;

export type StandaloneEditableArtifactApplication = Readonly<{
  application: EditableArtifactApplicationPort;
  durableExports: EditableArtifactDurableExportService;
  kernelVersion: string;
  close(): void;
}>;

/**
 * Standalone production composition. Every authority is durable: PostgreSQL
 * owns admission/authorization/history, object storage owns immutable model
 * bytes, and NATS carries wake-up hints only.
 */
export async function createStandaloneEditableArtifactApplication(input: {
  db: Database;
  bus: EventBus;
  objectStorage: ObjectStorage;
}): Promise<StandaloneEditableArtifactApplication> {
  const boundedObjects = createObjectStorageBoundedPorts(input.objectStorage);
  const materializationObjects = createObjectStorageBoundedPorts(input.objectStorage, {
    keyPrefix: "editable-artifacts/materializations/v1/sha256/",
  });
  const runtimeBinding = await loadVerifiedNativeArtifactRuntimeBinding();
  const runtime = runtimeBinding.runtime;
  const kernel = new NativeEditableArtifactKernelAdapter(runtime, boundedObjects.read);
  const persistedStore = new PostgresEditableArtifactStore(input.db);
  const store = editableArtifactStorePortFromPostgres(persistedStore);
  const authorization = new PostgresEditableArtifactAuthorization(input.db);
  const ids = new RandomEditableArtifactStableIds();
  const clock = new SystemEditableArtifactClock();
  const snapshotVerifier = new ProductionEditableArtifactSnapshotVerifier({
    objects: boundedObjects.read,
    kernel,
  });
  const genesis = new EditableArtifactGenesisPipeline({
    kernel,
    objects: boundedObjects.write,
    now: () => clock.now(),
  });
  const compaction = new EditableArtifactCompactionPipeline({
    kernel,
    objects: boundedObjects.write,
    now: () => clock.now(),
  });
  const domain = new EditableArtifactService({
    authorization,
    kernel,
    store,
    intentCodec: ogatxEditableArtifactMutationIntentCodec,
    clock,
    ids,
    snapshotVerifier,
    genesis,
    compaction,
  });
  const materializerCapabilities = editableArtifactMaterializerCapabilitiesForRuntime(
    runtime,
    runtimeBinding.location.artifactTool.packageVersion,
  );
  const durableExports = new EditableArtifactDurableExportService({
    authorization,
    exactSnapshots: Object.freeze({
      ensure: async (request: Parameters<EditableArtifactExactSnapshotPort["ensure"]>[0]) =>
        await domain.compactCurrentHead(request),
    }),
    store: editableArtifactDurableExportStorePortFromPostgres(
      new PostgresEditableArtifactDurableExportStore(input.db),
    ),
    ids: new RandomEditableArtifactDurableExportIds(),
    profiles: materializationProfiles(materializerCapabilities),
    materializationObjects: materializationObjects.read,
  });
  const ticketStore = new PostgresEditableArtifactLiveTicketStore(input.db);
  const liveRead = new PostgresEditableArtifactLiveReadStore(input.db, {
    snapshotBytes: snapshotBytesPort(boundedObjects.read),
  });
  const invalidations = new PollingEditableArtifactAuthorizationInvalidations(authorization);
  const live = new EditableArtifactLiveServer({
    authorization,
    domain,
    tickets: editableArtifactLiveTicketStorePortFromPostgres(ticketStore),
    tokens: new WebCryptoEditableArtifactLiveTokens(),
    clock: new SystemEditableArtifactLiveClock(),
    scheduler: new SystemEditableArtifactLiveScheduler(),
    read: editableArtifactLiveReadPortFromPostgres(liveRead),
    hints: new EventBusEditableArtifactLiveHints(input.bus),
    invalidations,
  });
  const compatibility: EditableArtifactLiveCompatibilityPort = Object.freeze({
    assertCompatible(
      request: Parameters<EditableArtifactLiveCompatibilityPort["assertCompatible"]>[0],
    ) {
      if (
        request.protocolVersion !== EDITABLE_ARTIFACT_LIVE_PROTOCOL_VERSION ||
        request.modelSchemaVersion !== 1 ||
        request.kernelVersion !== runtime.buildIdentity
      ) {
        throw new EditableArtifactCompatibilityError();
      }
    },
  });
  const application = new EditableArtifactApplication({
    domain,
    live,
    compatibility,
  });
  const cleanup = setInterval(() => {
    void ticketStore.cleanupExpired().catch(() => undefined);
  }, TICKET_CLEANUP_MS);
  cleanup.unref?.();
  return Object.freeze({
    application,
    durableExports,
    kernelVersion: runtime.buildIdentity,
    close() {
      clearInterval(cleanup);
      invalidations.close();
    },
  });
}

export class PostgresEditableArtifactAuthorization implements EditableArtifactAuthorizationPort {
  constructor(private readonly db: Database) {}

  async authorize(
    request: EditableArtifactAuthorizationRequest,
  ): Promise<EditableArtifactAuthorizationDecision> {
    const actor = request.actor;
    const rows = await withRlsContext(this.db, request.scope, async (tx) =>
      rawRows<{ allowed: boolean; authorization_revision: number | string | bigint }>(
        await tx.execute(dbSql`select *
          from opengeni_private.authorize_editable_artifact_actor(
            ${request.scope.accountId}::uuid,
            ${request.scope.workspaceId}::uuid,
            ${request.artifactId},
            ${actor.kind},
            ${actor.subjectId},
            ${actor.kind === "agent" ? actor.sessionId : null},
            ${actor.kind === "agent" ? actor.turnId : null},
            ${actor.kind === "agent" ? actor.attemptId : null},
            ${actor.kind === "agent" ? actor.generation : null},
            ${actor.kind === "service" ? actor.service : null},
            ${request.permission},
            current_schema()
          )`),
      ),
    );
    if (rows.length !== 1) throw new Error("Editable artifact authorization returned no decision");
    const revision = Number(rows[0]!.authorization_revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("Editable artifact authorization returned an invalid revision");
    }
    return Object.freeze({ allowed: rows[0]!.allowed === true, revision });
  }
}

class PollingEditableArtifactAuthorizationInvalidations implements EditableArtifactLiveAuthorizationInvalidationPort {
  private readonly stops = new Set<() => void>();

  constructor(private readonly authorization: EditableArtifactAuthorizationPort) {}

  async subscribe(
    input: Parameters<EditableArtifactLiveAuthorizationInvalidationPort["subscribe"]>[0],
  ): Promise<() => void> {
    let active = true;
    let polling = false;
    let baseline = await this.read(input);
    const timer = setInterval(() => {
      if (!active || polling) return;
      polling = true;
      void this.read(input)
        .then((next) => {
          if (!active) return;
          if (next !== baseline) {
            baseline = next;
            input.onInvalidated();
          }
        })
        .catch(() => {
          if (active) input.onInvalidated();
        })
        .finally(() => {
          polling = false;
        });
    }, INVALIDATION_POLL_MS);
    timer.unref?.();
    const stop = () => {
      if (!active) return;
      active = false;
      clearInterval(timer);
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    return stop;
  }

  close(): void {
    for (const stop of [...this.stops]) stop();
  }

  private async read(
    input: Parameters<EditableArtifactLiveAuthorizationInvalidationPort["subscribe"]>[0],
  ): Promise<string> {
    const decision = await this.authorization.authorize({
      scope: input.scope,
      artifactId: input.artifactId,
      actor: input.actor,
      permission: "read",
    });
    return `${decision.allowed ? 1 : 0}:${decision.revision}`;
  }
}

class RandomEditableArtifactStableIds implements EditableArtifactStableIdFactoryPort {
  next(_kind: EditableArtifactStableIdKind) {
    return randomUUID().replaceAll("-", "") as ReturnType<
      EditableArtifactStableIdFactoryPort["next"]
    >;
  }
}

class RandomEditableArtifactDurableExportIds implements EditableArtifactDurableExportIdFactoryPort {
  next(_kind: "version" | "materialization_job" | "receipt"): string {
    return randomUUID().replaceAll("-", "");
  }
}

function materializationProfiles(
  capabilities: EditableArtifactNativeMaterializerCapabilities,
): EditableArtifactMaterializationProfilePort {
  if (
    capabilities.protocol !== "OGAMC001" ||
    capabilities.runtimeKind !== "native" ||
    capabilities.maxOutputBytes !== EDITABLE_ARTIFACT_EXPORT_MAX_DOWNLOAD_BYTES ||
    capabilities.codecVersions["opengeni.xlsx"] === undefined ||
    !capabilities.supportedModelSchemaVersions.includes(1) ||
    !capabilities.supportedOperationProtocolVersions.includes(1) ||
    !capabilities.supportedSnapshotProtocolVersions.includes(1)
  ) {
    throw new Error("Verified artifact materializer profile is incompatible");
  }
  const codecVersion = capabilities.codecVersions["opengeni.xlsx"];
  return Object.freeze({
    async resolve(input: Parameters<EditableArtifactMaterializationProfilePort["resolve"]>[0]) {
      if (
        input.modality !== "spreadsheet" ||
        input.format !== "xlsx" ||
        Object.keys(input.options).length !== 0
      ) {
        return null;
      }
      return Object.freeze({
        modality: "spreadsheet" as const,
        format: "xlsx" as const,
        codecId: "opengeni.xlsx",
        codecVersion,
        kernelVersion: capabilities.kernelVersion,
        fontRegistryHash: capabilities.fontRegistryHash,
        policyHash: capabilities.policyHash,
        normalizedOptions: "{}",
      });
    },
  });
}

function snapshotBytesPort(
  objects: BoundedObjectReadPort,
): PersistedEditableArtifactSnapshotBytesPort {
  return Object.freeze({
    async readSnapshotBytes(snapshot: PersistedEditableArtifactSnapshotMetadata) {
      const object = await objects.open({
        opaqueReference: snapshot.blobReference,
        maxBytes: MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES,
        expectedByteSize: snapshot.byteSize,
      });
      try {
        if (object.contentType !== undefined && object.contentType !== snapshot.mimeType) {
          throw new Error("Editable artifact snapshot content type mismatch");
        }
        const bytes = new Uint8Array(snapshot.byteSize);
        const digest = createHash("sha256");
        let offset = 0;
        for await (const chunk of object.chunks({
          chunkBytes: MAX_BOUNDED_OBJECT_CHUNK_BYTES,
        })) {
          if (offset + chunk.byteLength > bytes.byteLength) {
            throw new Error("Editable artifact snapshot exceeds its declared size");
          }
          bytes.set(chunk, offset);
          digest.update(chunk);
          offset += chunk.byteLength;
        }
        if (
          offset !== bytes.byteLength ||
          `sha256:${digest.digest("hex")}` !== snapshot.contentHash
        ) {
          throw new Error("Editable artifact snapshot digest or size mismatch");
        }
        await object.assertUnchanged();
        return bytes;
      } finally {
        await object.close();
      }
    },
  });
}

function rawRows<T extends Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows)) return rows as T[];
  throw new Error("Unsupported database execute result shape");
}
