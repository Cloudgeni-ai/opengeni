import type { FileAsset, FileStatus, FileUploadStatus, ResourceRef, SandboxBackend, Session, SessionEvent, SessionEventType, SessionStatus, ToolRef } from "@infra-agents/contracts";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export type DbClient = {
  db: Database;
  close: () => Promise<void>;
};

export function createDb(databaseUrl: string): DbClient {
  const client = postgres(databaseUrl, { max: 10 });
  return {
    db: drizzle(client, { schema }),
    close: async () => {
      await client.end();
    },
  };
}

export type AppendEventInput = {
  type: SessionEventType;
  payload?: unknown;
  clientEventId?: string;
  turnId?: string | null;
  producerId?: string;
  producerSeq?: number;
  occurredAt?: Date;
};

export async function createFileUpload(db: Database, input: {
  fileId: string;
  filename: string;
  safeFilename: string;
  contentType: string;
  sizeBytes: number;
  sha256?: string | null;
  bucket: string;
  objectKey: string;
  expiresAt: Date;
}): Promise<{ file: FileAsset; uploadId: string; expiresAt: string }> {
  return await db.transaction(async (tx) => {
    const [fileRow] = await tx.insert(schema.files).values({
      id: input.fileId,
      filename: input.filename,
      safeFilename: input.safeFilename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256 ?? null,
      bucket: input.bucket,
      objectKey: input.objectKey,
      status: "pending_upload",
    }).returning();
    if (!fileRow) {
      throw new Error("Failed to create file");
    }
    const [uploadRow] = await tx.insert(schema.fileUploads).values({
      fileId: fileRow.id,
      status: "pending",
      expiresAt: input.expiresAt,
    }).returning({ id: schema.fileUploads.id, expiresAt: schema.fileUploads.expiresAt });
    if (!uploadRow) {
      throw new Error("Failed to create file upload");
    }
    return {
      file: mapFile(fileRow),
      uploadId: uploadRow.id,
      expiresAt: uploadRow.expiresAt.toISOString(),
    };
  });
}

export async function getFile(db: Database, fileId: string): Promise<FileAsset | null> {
  const [row] = await db.select().from(schema.files).where(eq(schema.files.id, fileId)).limit(1);
  return row ? mapFile(row) : null;
}

export async function requireFile(db: Database, fileId: string): Promise<FileAsset> {
  const file = await getFile(db, fileId);
  if (!file) {
    throw new Error(`File not found: ${fileId}`);
  }
  return file;
}

export async function getFileUpload(db: Database, uploadId: string): Promise<{ id: string; status: FileUploadStatus; expiresAt: Date; file: FileAsset } | null> {
  const [row] = await db.select({
    id: schema.fileUploads.id,
    status: schema.fileUploads.status,
    expiresAt: schema.fileUploads.expiresAt,
    file: schema.files,
  }).from(schema.fileUploads)
    .innerJoin(schema.files, eq(schema.fileUploads.fileId, schema.files.id))
    .where(eq(schema.fileUploads.id, uploadId))
    .limit(1);
  return row ? {
    id: row.id,
    status: row.status as FileUploadStatus,
    expiresAt: row.expiresAt,
    file: mapFile(row.file),
  } : null;
}

export async function completeFileUpload(db: Database, uploadId: string): Promise<FileAsset> {
  return await db.transaction(async (tx) => {
    const [uploadRow] = await tx.select().from(schema.fileUploads).where(eq(schema.fileUploads.id, uploadId)).for("update").limit(1);
    if (!uploadRow) {
      throw new Error(`File upload not found: ${uploadId}`);
    }
    const [fileRow] = await tx.select().from(schema.files).where(eq(schema.files.id, uploadRow.fileId)).for("update").limit(1);
    if (!fileRow) {
      throw new Error(`File not found for upload: ${uploadId}`);
    }
    const now = new Date();
    const [updatedFile] = await tx.update(schema.files).set({
      status: "ready",
      updatedAt: now,
    }).where(eq(schema.files.id, fileRow.id)).returning();
    await tx.update(schema.fileUploads).set({
      status: "completed",
      completedAt: now,
      updatedAt: now,
    }).where(eq(schema.fileUploads.id, uploadId));
    if (!updatedFile) {
      throw new Error("Failed to complete file upload");
    }
    return mapFile(updatedFile);
  });
}

export async function markFileUploadFailed(db: Database, uploadId: string, fileId: string): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(schema.fileUploads).set({ status: "failed", updatedAt: now }).where(eq(schema.fileUploads.id, uploadId));
    await tx.update(schema.files).set({ status: "failed", updatedAt: now }).where(eq(schema.files.id, fileId));
  });
}

export async function createSession(db: Database, input: {
  initialMessage: string;
  resources: ResourceRef[];
  tools?: ToolRef[];
  metadata: Record<string, unknown>;
  model: string;
  sandboxBackend: SandboxBackend;
}): Promise<Session> {
  const [row] = await db.insert(schema.sessions).values({
    initialMessage: input.initialMessage,
    resources: input.resources,
    tools: input.tools ?? [],
    metadata: input.metadata,
    model: input.model,
    sandboxBackend: input.sandboxBackend,
    status: "queued",
  }).returning();
  if (!row) {
    throw new Error("Failed to create session");
  }
  return mapSession(row);
}

export async function getSession(db: Database, sessionId: string): Promise<Session | null> {
  const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
  return row ? mapSession(row) : null;
}

export async function requireSession(db: Database, sessionId: string): Promise<Session> {
  const session = await getSession(db, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return session;
}

export async function listSessionEvents(db: Database, sessionId: string, after = 0, limit = 500): Promise<SessionEvent[]> {
  const rows = await db.select().from(schema.sessionEvents)
    .where(and(eq(schema.sessionEvents.sessionId, sessionId), gt(schema.sessionEvents.sequence, after)))
    .orderBy(asc(schema.sessionEvents.sequence))
    .limit(limit);
  return rows.map(mapEvent);
}

export async function getSessionEvent(db: Database, eventId: string): Promise<SessionEvent | null> {
  const [row] = await db.select().from(schema.sessionEvents).where(eq(schema.sessionEvents.id, eventId)).limit(1);
  return row ? mapEvent(row) : null;
}

export async function getLatestRunState(db: Database, sessionId: string): Promise<{
  id: string;
  serializedRunState: string;
  pendingApprovals: unknown[];
} | null> {
  const [row] = await db.select().from(schema.agentRunStates)
    .where(eq(schema.agentRunStates.sessionId, sessionId))
    .orderBy(desc(schema.agentRunStates.createdAt))
    .limit(1);
  return row ? {
    id: row.id,
    serializedRunState: row.serializedRunState,
    pendingApprovals: row.pendingApprovals,
  } : null;
}

export async function saveRunState(db: Database, input: {
  sessionId: string;
  turnId?: string | null;
  serializedRunState: string;
  pendingApprovals: unknown[];
}): Promise<void> {
  const [{ maxVersion } = { maxVersion: 0 }] = await db.select({
    maxVersion: sql<number>`coalesce(max(${schema.agentRunStates.stateVersion}), 0)`,
  }).from(schema.agentRunStates).where(eq(schema.agentRunStates.sessionId, input.sessionId));
  await db.insert(schema.agentRunStates).values({
    sessionId: input.sessionId,
    turnId: input.turnId ?? null,
    stateVersion: Number(maxVersion) + 1,
    serializedRunState: input.serializedRunState,
    pendingApprovals: input.pendingApprovals,
  });
}

export async function createTurn(db: Database, input: {
  sessionId: string;
  triggerEventId: string;
  temporalWorkflowId: string;
}): Promise<string> {
  const [row] = await db.insert(schema.sessionTurns).values({
    sessionId: input.sessionId,
    triggerEventId: input.triggerEventId,
    temporalWorkflowId: input.temporalWorkflowId,
    status: "running",
  }).returning({ id: schema.sessionTurns.id });
  if (!row) {
    throw new Error("Failed to create turn");
  }
  await db.update(schema.sessions).set({
    activeTurnId: row.id,
    status: "running",
    updatedAt: new Date(),
  }).where(eq(schema.sessions.id, input.sessionId));
  return row.id;
}

export async function setSessionStatus(db: Database, sessionId: string, status: SessionStatus, activeTurnId?: string | null): Promise<void> {
  await db.update(schema.sessions).set({
    status,
    activeTurnId: activeTurnId === undefined ? undefined : activeTurnId,
    updatedAt: new Date(),
  }).where(eq(schema.sessions.id, sessionId));
}

export async function setTemporalWorkflowId(db: Database, sessionId: string, workflowId: string): Promise<void> {
  await db.update(schema.sessions).set({
    temporalWorkflowId: workflowId,
    updatedAt: new Date(),
  }).where(eq(schema.sessions.id, sessionId));
}

export async function finishTurn(db: Database, turnId: string, status: SessionStatus): Promise<void> {
  await db.update(schema.sessionTurns).set({
    status,
    updatedAt: new Date(),
  }).where(eq(schema.sessionTurns.id, turnId));
}

export async function appendSessionEvents(db: Database, sessionId: string, inputs: AppendEventInput[]): Promise<SessionEvent[]> {
  if (inputs.length === 0) {
    return [];
  }
  return await db.transaction(async (tx) => {
    const locked = await tx.execute(sql<{ last_sequence: number }>`select last_sequence from sessions where id = ${sessionId} for update`);
    const row = locked[0];
    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    let sequence = Number(row.last_sequence);
    const values = inputs.map((input) => ({
      sessionId,
      sequence: ++sequence,
      type: input.type,
      payload: input.payload ?? {},
      clientEventId: input.clientEventId ?? null,
      turnId: input.turnId ?? null,
      producerId: input.producerId ?? null,
      producerSeq: input.producerSeq ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    }));
    const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
    await tx.update(schema.sessions).set({ lastSequence: sequence, updatedAt: new Date() }).where(eq(schema.sessions.id, sessionId));
    return inserted.map(mapEvent);
  });
}

export async function appendSessionEventsAndUpdateSession(db: Database, sessionId: string, inputs: AppendEventInput[], update: {
  resources?: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  metadata?: Record<string, unknown>;
  status?: SessionStatus;
  activeTurnId?: string | null;
}): Promise<SessionEvent[]> {
  if (inputs.length === 0) {
    return [];
  }
  return await db.transaction(async (tx) => {
    const locked = await tx.execute(sql<{ last_sequence: number }>`select last_sequence from sessions where id = ${sessionId} for update`);
    const row = locked[0];
    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    let sequence = Number(row.last_sequence);
    const now = new Date();
    const values = inputs.map((input) => ({
      sessionId,
      sequence: ++sequence,
      type: input.type,
      payload: input.payload ?? {},
      clientEventId: input.clientEventId ?? null,
      turnId: input.turnId ?? null,
      producerId: input.producerId ?? null,
      producerSeq: input.producerSeq ?? null,
      occurredAt: input.occurredAt ?? now,
    }));
    const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
    await tx.update(schema.sessions).set({
      lastSequence: sequence,
      ...(update.resources !== undefined ? { resources: update.resources } : {}),
      ...(update.tools !== undefined ? { tools: update.tools } : {}),
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.activeTurnId !== undefined ? { activeTurnId: update.activeTurnId } : {}),
      updatedAt: now,
    }).where(eq(schema.sessions.id, sessionId));
    return inserted.map(mapEvent);
  });
}

export async function appendSessionEventsWithLockedSessionUpdate(db: Database, sessionId: string, build: (session: Session) => {
  events: AppendEventInput[];
  update?: {
    resources?: ResourceRef[];
    tools?: ToolRef[];
    model?: string;
    metadata?: Record<string, unknown>;
    status?: SessionStatus;
    activeTurnId?: string | null;
  };
}): Promise<SessionEvent[]> {
  return await db.transaction(async (tx) => {
    const [sessionRow] = await tx.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).for("update").limit(1);
    if (!sessionRow) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const built = build(mapSession(sessionRow));
    if (built.events.length === 0) {
      return [];
    }
    let sequence = sessionRow.lastSequence;
    const now = new Date();
    const values = built.events.map((input) => ({
      sessionId,
      sequence: ++sequence,
      type: input.type,
      payload: input.payload ?? {},
      clientEventId: input.clientEventId ?? null,
      turnId: input.turnId ?? null,
      producerId: input.producerId ?? null,
      producerSeq: input.producerSeq ?? null,
      occurredAt: input.occurredAt ?? now,
    }));
    const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
    const update = built.update ?? {};
    await tx.update(schema.sessions).set({
      lastSequence: sequence,
      ...(update.resources !== undefined ? { resources: update.resources } : {}),
      ...(update.tools !== undefined ? { tools: update.tools } : {}),
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.activeTurnId !== undefined ? { activeTurnId: update.activeTurnId } : {}),
      updatedAt: now,
    }).where(eq(schema.sessions.id, sessionId));
    return inserted.map(mapEvent);
  });
}

export function sessionSubject(sessionId: string): string {
  return `sessions.${sessionId}.events`;
}

function mapSession(row: typeof schema.sessions.$inferSelect): Session {
  return {
    id: row.id,
    status: row.status as SessionStatus,
    initialMessage: row.initialMessage,
    resources: row.resources as ResourceRef[],
    tools: row.tools as ToolRef[],
    metadata: row.metadata,
    model: row.model,
    sandboxBackend: row.sandboxBackend as SandboxBackend,
    temporalWorkflowId: row.temporalWorkflowId,
    activeTurnId: row.activeTurnId,
    lastSequence: row.lastSequence,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapEvent(row: typeof schema.sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    sequence: row.sequence,
    type: row.type as SessionEventType,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    clientEventId: row.clientEventId,
    turnId: row.turnId,
  };
}

function mapFile(row: typeof schema.files.$inferSelect): FileAsset {
  return {
    id: row.id,
    status: row.status as FileStatus,
    filename: row.filename,
    safeFilename: row.safeFilename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    bucket: row.bucket,
    objectKey: row.objectKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
