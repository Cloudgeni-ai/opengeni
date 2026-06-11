import {
  CreateWorkspaceEnvironmentRequest,
  SetWorkspaceEnvironmentVariableRequest,
  UpdateWorkspaceEnvironmentRequest,
  WorkspaceEnvironmentVariableName,
} from "@opengeni/contracts";
import {
  countActiveSessionsUsingEnvironment,
  countScheduledTasksUsingEnvironment,
  countWorkspaceEnvironments,
  createWorkspaceEnvironment,
  deleteWorkspaceEnvironment,
  deleteWorkspaceEnvironmentVariable,
  encryptEnvironmentValue,
  getWorkspaceEnvironmentByName,
  listWorkspaceEnvironments,
  setWorkspaceEnvironmentVariable,
  updateWorkspaceEnvironment,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "../access";
import type { ApiRouteDeps } from "../dependencies";
import {
  assertAllowedEnvironmentVariableName,
  MAX_ENVIRONMENTS_PER_WORKSPACE,
  MAX_VARIABLES_PER_ENVIRONMENT,
  recordEnvironmentAuditEvent,
  requireEnvironmentEncryption,
  requireEnvironmentForApi,
} from "../domain/environments";

export function registerEnvironmentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, db } = deps;

  app.get("/v1/workspaces/:workspaceId/environments", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "environments:use");
    return c.json(await listWorkspaceEnvironments(db, workspaceId));
  });

  app.post("/v1/workspaces/:workspaceId/environments", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "environments:manage");
    const key = requireEnvironmentEncryption(settings);
    const payload = CreateWorkspaceEnvironmentRequest.parse(await c.req.json());
    const name = trimmedEnvironmentName(payload.name);
    if (payload.variables.length > MAX_VARIABLES_PER_ENVIRONMENT) {
      throw new HTTPException(422, { message: `an environment supports at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables` });
    }
    const variableNames = new Set<string>();
    for (const variable of payload.variables) {
      assertAllowedEnvironmentVariableName(variable.name);
      if (variableNames.has(variable.name)) {
        throw new HTTPException(422, { message: `duplicate environment variable name: ${variable.name}` });
      }
      variableNames.add(variable.name);
    }
    if (await countWorkspaceEnvironments(db, workspaceId) >= MAX_ENVIRONMENTS_PER_WORKSPACE) {
      throw new HTTPException(422, { message: `a workspace supports at most ${MAX_ENVIRONMENTS_PER_WORKSPACE} environments` });
    }
    if (await getWorkspaceEnvironmentByName(db, workspaceId, name)) {
      throw new HTTPException(409, { message: `environment name is already in use: ${name}` });
    }
    // Values are encrypted up front and the environment plus all initial
    // variables are written in one transaction: a failure leaves nothing.
    const created = await createWorkspaceEnvironment(db, {
      accountId: grant.accountId,
      workspaceId,
      name,
      description: payload.description ?? null,
      variables: payload.variables.map((variable) => ({
        name: variable.name,
        valueEncrypted: encryptEnvironmentValue(key, variable.value),
      })),
    });
    await recordEnvironmentAuditEvent(db, { grant, action: "environment.created", environmentId: created.id });
    return c.json(created, 201);
  });

  app.get("/v1/workspaces/:workspaceId/environments/:environmentId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "environments:use");
    return c.json(await requireEnvironmentForApi(db, workspaceId, c.req.param("environmentId")));
  });

  app.patch("/v1/workspaces/:workspaceId/environments/:environmentId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "environments:manage");
    const environment = await requireEnvironmentForApi(db, workspaceId, c.req.param("environmentId"));
    const payload = UpdateWorkspaceEnvironmentRequest.parse(await c.req.json());
    const name = payload.name !== undefined ? trimmedEnvironmentName(payload.name) : undefined;
    if (name !== undefined && name !== environment.name) {
      const existing = await getWorkspaceEnvironmentByName(db, workspaceId, name);
      if (existing && existing.id !== environment.id) {
        throw new HTTPException(409, { message: `environment name is already in use: ${name}` });
      }
    }
    const updated = await updateWorkspaceEnvironment(db, workspaceId, environment.id, {
      ...(name !== undefined ? { name } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
    });
    await recordEnvironmentAuditEvent(db, { grant, action: "environment.updated", environmentId: environment.id });
    return c.json(updated);
  });

  app.delete("/v1/workspaces/:workspaceId/environments/:environmentId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "environments:manage");
    const environment = await requireEnvironmentForApi(db, workspaceId, c.req.param("environmentId"));
    const attachedTasks = await countScheduledTasksUsingEnvironment(db, workspaceId, environment.id);
    if (attachedTasks > 0) {
      throw new HTTPException(409, { message: `environment is attached to ${attachedTasks} scheduled task(s); detach first` });
    }
    const activeSessions = await countActiveSessionsUsingEnvironment(db, workspaceId, environment.id);
    if (activeSessions > 0) {
      throw new HTTPException(409, { message: `environment is attached to ${activeSessions} active session(s); wait for them to finish or cancel them first` });
    }
    await deleteWorkspaceEnvironment(db, workspaceId, environment.id);
    await recordEnvironmentAuditEvent(db, { grant, action: "environment.deleted", environmentId: environment.id });
    return c.json({ ok: true });
  });

  app.put("/v1/workspaces/:workspaceId/environments/:environmentId/variables/:name", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "environments:manage");
    const key = requireEnvironmentEncryption(settings);
    const name = parseVariableName(c.req.param("name"));
    const environment = await requireEnvironmentForApi(db, workspaceId, c.req.param("environmentId"));
    const payload = SetWorkspaceEnvironmentVariableRequest.parse(await c.req.json());
    const exists = environment.variables.some((variable) => variable.name === name);
    if (!exists && environment.variables.length >= MAX_VARIABLES_PER_ENVIRONMENT) {
      throw new HTTPException(422, { message: `an environment supports at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables` });
    }
    const metadata = await setWorkspaceEnvironmentVariable(db, {
      accountId: grant.accountId,
      workspaceId,
      environmentId: environment.id,
      name,
      valueEncrypted: encryptEnvironmentValue(key, payload.value),
    });
    await recordEnvironmentAuditEvent(db, { grant, action: "environment.variable.set", environmentId: environment.id, variableName: name });
    return c.json(metadata);
  });

  app.delete("/v1/workspaces/:workspaceId/environments/:environmentId/variables/:name", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "environments:manage");
    const name = parseVariableName(c.req.param("name"));
    const environment = await requireEnvironmentForApi(db, workspaceId, c.req.param("environmentId"));
    const deleted = await deleteWorkspaceEnvironmentVariable(db, workspaceId, environment.id, name);
    if (!deleted) {
      throw new HTTPException(404, { message: "environment variable not found" });
    }
    await recordEnvironmentAuditEvent(db, { grant, action: "environment.variable.deleted", environmentId: environment.id, variableName: name });
    return c.json({ ok: true });
  });
}

function parseVariableName(raw: string): string {
  const parsed = WorkspaceEnvironmentVariableName.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(422, { message: "environment variable names must match ^[A-Z][A-Z0-9_]*$" });
  }
  assertAllowedEnvironmentVariableName(parsed.data);
  return parsed.data;
}

function trimmedEnvironmentName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new HTTPException(422, { message: "environment name is required" });
  }
  return trimmed;
}
