import type {
  FileAsset,
  FileStatus,
  FileUploadStatus,
  ResourceRef,
  SandboxBackend,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskOverlapPolicy,
  ScheduledTaskRun,
  ScheduledTaskRunMode,
  ScheduledTaskRunStatus,
  ScheduledTaskScheduleSpec,
  ScheduledTaskStatus,
  ScheduledTaskTriggerType,
  Session,
  SessionEvent,
  SessionEventType,
  SessionStatus,
  SessionTurn,
  SessionTurnSource,
  SessionTurnStatus,
  ToolRef,
  ReasoningEffort,
} from "@infra-agents/contracts";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
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

export type CreateScheduledTaskInput = {
  id?: string;
  name: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskScheduleSpec;
  temporalScheduleId: string;
  runMode: ScheduledTaskRunMode;
  overlapPolicy: ScheduledTaskOverlapPolicy;
  agentConfig: ScheduledTaskAgentConfig;
  metadata: Record<string, unknown>;
};

export type UpdateScheduledTaskInput = Partial<{
  name: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskScheduleSpec;
  runMode: ScheduledTaskRunMode;
  overlapPolicy: ScheduledTaskOverlapPolicy;
  agentConfig: ScheduledTaskAgentConfig;
  reusableSessionId: string | null;
  metadata: Record<string, unknown>;
}>;

export type EnqueueSessionTurnInput = {
  sessionId: string;
  triggerEventId: string;
  temporalWorkflowId: string;
  source: SessionTurnSource;
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxBackend: SandboxBackend;
  metadata: Record<string, unknown>;
};

export type UpdateQueuedSessionTurnInput = Partial<{
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxBackend: SandboxBackend;
  metadata: Record<string, unknown>;
}>;

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

export async function createScheduledTask(db: Database, input: CreateScheduledTaskInput): Promise<ScheduledTask> {
  const [row] = await db.insert(schema.scheduledTasks).values(input).returning();
  if (!row) {
    throw new Error("Failed to create scheduled task");
  }
  return mapScheduledTask(row);
}

export async function updateScheduledTask(db: Database, taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
  const [row] = await db.update(schema.scheduledTasks).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
    ...(input.runMode !== undefined ? { runMode: input.runMode } : {}),
    ...(input.overlapPolicy !== undefined ? { overlapPolicy: input.overlapPolicy } : {}),
    ...(input.agentConfig !== undefined ? { agentConfig: input.agentConfig } : {}),
    ...(input.reusableSessionId !== undefined ? { reusableSessionId: input.reusableSessionId } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.scheduledTasks.id, taskId)).returning();
  if (!row) {
    throw new Error(`Scheduled task not found: ${taskId}`);
  }
  return mapScheduledTask(row);
}

export async function getScheduledTask(db: Database, taskId: string): Promise<ScheduledTask | null> {
  const [row] = await db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, taskId)).limit(1);
  return row ? mapScheduledTask(row) : null;
}

export async function requireScheduledTask(db: Database, taskId: string): Promise<ScheduledTask> {
  const task = await getScheduledTask(db, taskId);
  if (!task) {
    throw new Error(`Scheduled task not found: ${taskId}`);
  }
  return task;
}

export async function listScheduledTasks(db: Database, limit = 100): Promise<ScheduledTask[]> {
  const rows = await db.select().from(schema.scheduledTasks).orderBy(desc(schema.scheduledTasks.createdAt)).limit(limit);
  return rows.map(mapScheduledTask);
}

export async function deleteScheduledTask(db: Database, taskId: string): Promise<void> {
  await db.delete(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, taskId));
}

export async function createScheduledTaskRun(db: Database, input: {
  taskId: string;
  triggerType: ScheduledTaskTriggerType;
  scheduledAt?: Date | null;
  firedAt?: Date;
}): Promise<ScheduledTaskRun> {
  const [row] = await db.insert(schema.scheduledTaskRuns).values({
    taskId: input.taskId,
    triggerType: input.triggerType,
    scheduledAt: input.scheduledAt ?? null,
    firedAt: input.firedAt ?? new Date(),
    status: "queued",
  }).returning();
  if (!row) {
    throw new Error("Failed to create scheduled task run");
  }
  return mapScheduledTaskRun(row);
}

export async function updateScheduledTaskRun(db: Database, runId: string, input: Partial<{
  status: ScheduledTaskRunStatus;
  sessionId: string | null;
  triggerEventId: string | null;
  error: string | null;
}>): Promise<ScheduledTaskRun> {
  const [row] = await db.update(schema.scheduledTaskRuns).set({
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.triggerEventId !== undefined ? { triggerEventId: input.triggerEventId } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.scheduledTaskRuns.id, runId)).returning();
  if (!row) {
    throw new Error(`Scheduled task run not found: ${runId}`);
  }
  return mapScheduledTaskRun(row);
}

export async function listScheduledTaskRuns(db: Database, taskId: string, limit = 100): Promise<ScheduledTaskRun[]> {
  const rows = await db.select().from(schema.scheduledTaskRuns)
    .where(eq(schema.scheduledTaskRuns.taskId, taskId))
    .orderBy(desc(schema.scheduledTaskRuns.createdAt))
    .limit(limit);
  return rows.map(mapScheduledTaskRun);
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
  const session = await requireSession(db, input.sessionId);
  const trigger = await getSessionEvent(db, input.triggerEventId);
  const position = await nextTurnPosition(db, input.sessionId);
  const [row] = await db.insert(schema.sessionTurns).values({
    sessionId: input.sessionId,
    triggerEventId: input.triggerEventId,
    temporalWorkflowId: input.temporalWorkflowId,
    status: "running",
    source: "user",
    position,
    prompt: promptFromTrigger(trigger?.payload) ?? session.initialMessage,
    resources: resourcesFromTrigger(trigger?.payload) ?? session.resources,
    tools: toolsFromTrigger(trigger?.payload) ?? session.tools,
    model: session.model,
    reasoningEffort: reasoningEffortFromSession(session),
    sandboxBackend: session.sandboxBackend,
    metadata: {},
    startedAt: new Date(),
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

export async function enqueueSessionTurn(db: Database, input: EnqueueSessionTurnInput): Promise<SessionTurn> {
  return await db.transaction(async (tx) => {
    const position = await nextTurnPosition(tx, input.sessionId);
    const [row] = await tx.insert(schema.sessionTurns).values({
      sessionId: input.sessionId,
      triggerEventId: input.triggerEventId,
      temporalWorkflowId: input.temporalWorkflowId,
      status: "queued",
      source: input.source,
      position,
      prompt: input.prompt,
      resources: input.resources,
      tools: input.tools,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sandboxBackend: input.sandboxBackend,
      metadata: input.metadata,
    }).returning();
    if (!row) {
      throw new Error("Failed to enqueue session turn");
    }
    return mapSessionTurn(row);
  });
}

export async function claimNextQueuedTurn(db: Database, sessionId: string, workflowId: string): Promise<SessionTurn | null> {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute(sql<{ id: string }>`
      select id from session_turns
      where session_id = ${sessionId} and status = 'queued'
      order by position asc, created_at asc, id asc
      for update skip locked
      limit 1
    `);
    const id = rows[0]?.id as string | undefined;
    if (!id) {
      return null;
    }
    const [row] = await tx.update(schema.sessionTurns).set({
      status: "running",
      temporalWorkflowId: workflowId,
      startedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.sessionTurns.id, id)).returning();
    if (!row) {
      throw new Error(`Session turn not found: ${id}`);
    }
    await tx.update(schema.sessions).set({
      status: "running",
      activeTurnId: row.id,
      updatedAt: new Date(),
    }).where(eq(schema.sessions.id, sessionId));
    return mapSessionTurn(row);
  });
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

export async function finishTurn(db: Database, turnId: string, status: SessionStatus | SessionTurnStatus): Promise<void> {
  await db.update(schema.sessionTurns).set({
    status: turnStatusForFinish(status),
    finishedAt: status === "requires_action" ? undefined : new Date(),
    updatedAt: new Date(),
  }).where(eq(schema.sessionTurns.id, turnId));
}

export async function getSessionTurn(db: Database, turnId: string): Promise<SessionTurn | null> {
  const [row] = await db.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.id, turnId)).limit(1);
  return row ? mapSessionTurn(row) : null;
}

export async function listSessionTurns(db: Database, sessionId: string, limit = 100): Promise<SessionTurn[]> {
  const rows = await db.select().from(schema.sessionTurns)
    .where(eq(schema.sessionTurns.sessionId, sessionId))
    .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt))
    .limit(limit);
  return rows.map(mapSessionTurn);
}

export async function updateQueuedSessionTurn(db: Database, turnId: string, input: UpdateQueuedSessionTurnInput): Promise<SessionTurn> {
  const [row] = await db.update(schema.sessionTurns).set({
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.resources !== undefined ? { resources: input.resources } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.sandboxBackend !== undefined ? { sandboxBackend: input.sandboxBackend } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    updatedAt: new Date(),
  }).where(and(eq(schema.sessionTurns.id, turnId), eq(schema.sessionTurns.status, "queued"))).returning();
  if (!row) {
    throw new Error(`Queued session turn not found: ${turnId}`);
  }
  return mapSessionTurn(row);
}

export async function cancelQueuedSessionTurn(db: Database, turnId: string): Promise<SessionTurn> {
  const [row] = await db.update(schema.sessionTurns).set({
    status: "cancelled",
    finishedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(schema.sessionTurns.id, turnId), eq(schema.sessionTurns.status, "queued"))).returning();
  if (!row) {
    throw new Error(`Queued session turn not found: ${turnId}`);
  }
  return mapSessionTurn(row);
}

export async function reorderQueuedSessionTurns(db: Database, sessionId: string, turnIds: string[]): Promise<SessionTurn[]> {
  return await db.transaction(async (tx) => {
    const rows = await tx.select().from(schema.sessionTurns)
      .where(and(eq(schema.sessionTurns.sessionId, sessionId), eq(schema.sessionTurns.status, "queued"), inArray(schema.sessionTurns.id, turnIds)));
    if (rows.length !== turnIds.length) {
      throw new Error("All reordered turns must be queued turns in the session");
    }
    let index = 0;
    for (const turnId of turnIds) {
      index += 1;
      await tx.update(schema.sessionTurns).set({
        position: index,
        updatedAt: new Date(),
      }).where(eq(schema.sessionTurns.id, turnId));
    }
    const updated = await tx.select().from(schema.sessionTurns)
      .where(and(eq(schema.sessionTurns.sessionId, sessionId), eq(schema.sessionTurns.status, "queued")))
      .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt));
    return updated.map(mapSessionTurn);
  });
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

function mapSessionTurn(row: typeof schema.sessionTurns.$inferSelect): SessionTurn {
  return {
    id: row.id,
    sessionId: row.sessionId,
    triggerEventId: row.triggerEventId,
    temporalWorkflowId: row.temporalWorkflowId,
    status: row.status as SessionTurnStatus,
    source: row.source as SessionTurnSource,
    position: row.position,
    prompt: row.prompt,
    resources: row.resources as ResourceRef[],
    tools: row.tools as ToolRef[],
    model: row.model,
    reasoningEffort: row.reasoningEffort as ReasoningEffort,
    sandboxBackend: row.sandboxBackend as SandboxBackend,
    metadata: row.metadata,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function nextTurnPosition(db: Database, sessionId: string): Promise<number> {
  const [{ maxPosition } = { maxPosition: 0 }] = await db.select({
    maxPosition: sql<number>`coalesce(max(${schema.sessionTurns.position}), 0)`,
  }).from(schema.sessionTurns).where(eq(schema.sessionTurns.sessionId, sessionId));
  return Number(maxPosition) + 1;
}

function turnStatusForFinish(status: SessionStatus | SessionTurnStatus): SessionTurnStatus {
  if (status === "idle") {
    return "completed";
  }
  if (status === "queued") {
    return "queued";
  }
  if (status === "running") {
    return "running";
  }
  return status;
}

function promptFromTrigger(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string") {
    return payload.text;
  }
  return null;
}

function resourcesFromTrigger(payload: unknown): ResourceRef[] | null {
  if (payload && typeof payload === "object" && "resources" in payload && Array.isArray(payload.resources)) {
    return payload.resources as ResourceRef[];
  }
  return null;
}

function toolsFromTrigger(payload: unknown): ToolRef[] | null {
  if (payload && typeof payload === "object" && "tools" in payload && Array.isArray(payload.tools)) {
    return payload.tools as ToolRef[];
  }
  return null;
}

function reasoningEffortFromSession(session: Session): ReasoningEffort {
  const value = session.metadata.reasoningEffort;
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "medium";
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

function mapScheduledTask(row: typeof schema.scheduledTasks.$inferSelect): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    status: row.status as ScheduledTaskStatus,
    schedule: row.schedule as ScheduledTaskScheduleSpec,
    temporalScheduleId: row.temporalScheduleId,
    runMode: row.runMode as ScheduledTaskRunMode,
    overlapPolicy: row.overlapPolicy as ScheduledTaskOverlapPolicy,
    agentConfig: row.agentConfig as ScheduledTaskAgentConfig,
    reusableSessionId: row.reusableSessionId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapScheduledTaskRun(row: typeof schema.scheduledTaskRuns.$inferSelect): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status as ScheduledTaskRunStatus,
    triggerType: row.triggerType as ScheduledTaskTriggerType,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    firedAt: row.firedAt.toISOString(),
    sessionId: row.sessionId,
    triggerEventId: row.triggerEventId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
