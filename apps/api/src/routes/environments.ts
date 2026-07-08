import {
  CreateVariableSetRequest,
  SetVariableSetVariableRequest,
  UpdateVariableSetRequest,
  VariableSetVariableName,
} from "@opengeni/contracts";
import {
  countActiveSessionsUsingVariableSet,
  countScheduledTasksUsingVariableSet,
  countVariableSets,
  createVariableSet,
  deleteVariableSet,
  deleteVariableSetVariable,
  encryptVariableSetValue,
  getVariableSetByName,
  listVariableSets,
  setVariableSetVariable,
  updateVariableSet,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  assertAllowedVariableSetVariableName,
  MAX_ENVIRONMENTS_PER_WORKSPACE,
  MAX_VARIABLES_PER_ENVIRONMENT,
  recordVariableSetAuditEvent,
  requireVariableSetEncryption,
  requireVariableSetForApi,
} from "@opengeni/core";

export function registerVariableSetRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, db } = deps;
  const prefixes = [
    "/v1/workspaces/:workspaceId/variable-sets",
    "/v1/workspaces/:workspaceId/environments",
  ];

  for (const prefix of prefixes) {
  app.get(`${prefix}`, async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    await requireAccessGrant(c, deps, workspaceId, "variable-sets:use");
    return c.json(await listVariableSets(db, workspaceId));
  });

  app.post(`${prefix}`, async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const grant = await requireAccessGrant(c, deps, workspaceId, "variable-sets:manage");
    const key = requireVariableSetEncryption(settings);
    const payload = CreateVariableSetRequest.parse(await c.req.json());
    const name = trimmedVariableSetName(payload.name);
    if (payload.variables.length > MAX_VARIABLES_PER_ENVIRONMENT) {
      throw new HTTPException(422, { message: `a variable set supports at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables` });
    }
    const variableNames = new Set<string>();
    for (const variable of payload.variables) {
      assertAllowedVariableSetVariableName(variable.name);
      if (variableNames.has(variable.name)) {
        throw new HTTPException(422, { message: `duplicate variable set variable name: ${variable.name}` });
      }
      variableNames.add(variable.name);
    }
    if (await countVariableSets(db, workspaceId) >= MAX_ENVIRONMENTS_PER_WORKSPACE) {
      throw new HTTPException(422, { message: `a workspace supports at most ${MAX_ENVIRONMENTS_PER_WORKSPACE} variable sets` });
    }
    if (await getVariableSetByName(db, workspaceId, name)) {
      throw new HTTPException(409, { message: `variable set name is already in use: ${name}` });
    }
    // Values are encrypted up front and the variableSet plus all initial
    // variables are written in one transaction: a failure leaves nothing.
    const created = await createVariableSet(db, {
      accountId: grant.accountId,
      workspaceId,
      name,
      description: payload.description ?? null,
      variables: payload.variables.map((variable) => ({
        name: variable.name,
        valueEncrypted: encryptVariableSetValue(key, variable.value),
      })),
    });
    await recordVariableSetAuditEvent(db, { grant, action: "variable_set.created", variableSetId: created.id });
    return c.json(created, 201);
  });

  app.get(`${prefix}/:variableSetId`, async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    await requireAccessGrant(c, deps, workspaceId, "variable-sets:use");
    return c.json(await requireVariableSetForApi(db, workspaceId, c.req.param("variableSetId")!));
  });

  app.patch(`${prefix}/:variableSetId`, async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const grant = await requireAccessGrant(c, deps, workspaceId, "variable-sets:manage");
    const variableSet = await requireVariableSetForApi(db, workspaceId, c.req.param("variableSetId")!);
    const payload = UpdateVariableSetRequest.parse(await c.req.json());
    const name = payload.name !== undefined ? trimmedVariableSetName(payload.name) : undefined;
    if (name !== undefined && name !== variableSet.name) {
      const existing = await getVariableSetByName(db, workspaceId, name);
      if (existing && existing.id !== variableSet.id) {
        throw new HTTPException(409, { message: `variable set name is already in use: ${name}` });
      }
    }
    const updated = await updateVariableSet(db, workspaceId, variableSet.id, {
      ...(name !== undefined ? { name } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
    });
    await recordVariableSetAuditEvent(db, { grant, action: "variable_set.updated", variableSetId: variableSet.id });
    return c.json(updated);
  });

  app.delete(`${prefix}/:variableSetId`, async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const grant = await requireAccessGrant(c, deps, workspaceId, "variable-sets:manage");
    const variableSet = await requireVariableSetForApi(db, workspaceId, c.req.param("variableSetId")!);
    const attachedTasks = await countScheduledTasksUsingVariableSet(db, workspaceId, variableSet.id);
    if (attachedTasks > 0) {
      throw new HTTPException(409, { message: `variable set is attached to ${attachedTasks} scheduled task(s); detach first` });
    }
    const activeSessions = await countActiveSessionsUsingVariableSet(db, workspaceId, variableSet.id);
    if (activeSessions > 0) {
      throw new HTTPException(409, { message: `variable set is attached to ${activeSessions} active session(s); wait for them to finish or cancel them first` });
    }
    await deleteVariableSet(db, workspaceId, variableSet.id);
    await recordVariableSetAuditEvent(db, { grant, action: "variable_set.deleted", variableSetId: variableSet.id });
    return c.json({ ok: true });
  });

  app.put(`${prefix}/:variableSetId/variables/:name`, async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const grant = await requireAccessGrant(c, deps, workspaceId, "variable-sets:manage");
    const key = requireVariableSetEncryption(settings);
    const name = parseVariableName(c.req.param("name")!);
    const variableSet = await requireVariableSetForApi(db, workspaceId, c.req.param("variableSetId")!);
    const payload = SetVariableSetVariableRequest.parse(await c.req.json());
    const exists = variableSet.variables.some((variable) => variable.name === name);
    if (!exists && variableSet.variables.length >= MAX_VARIABLES_PER_ENVIRONMENT) {
      throw new HTTPException(422, { message: `a variable set supports at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables` });
    }
    const metadata = await setVariableSetVariable(db, {
      accountId: grant.accountId,
      workspaceId,
      variableSetId: variableSet.id,
      name,
      valueEncrypted: encryptVariableSetValue(key, payload.value),
    });
    await recordVariableSetAuditEvent(db, { grant, action: "variable_set.variable.set", variableSetId: variableSet.id, variableName: name });
    return c.json(metadata);
  });

  app.delete(`${prefix}/:variableSetId/variables/:name`, async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const grant = await requireAccessGrant(c, deps, workspaceId, "variable-sets:manage");
    const name = parseVariableName(c.req.param("name")!);
    const variableSet = await requireVariableSetForApi(db, workspaceId, c.req.param("variableSetId")!);
    const deleted = await deleteVariableSetVariable(db, workspaceId, variableSet.id, name);
    if (!deleted) {
      throw new HTTPException(404, { message: "variable set variable not found" });
    }
    await recordVariableSetAuditEvent(db, { grant, action: "variable_set.variable.deleted", variableSetId: variableSet.id, variableName: name });
    return c.json({ ok: true });
  });
  }
}

/** @deprecated use registerVariableSetRoutes */
export const registerEnvironmentRoutes = registerVariableSetRoutes;

function parseVariableName(raw: string): string {
  const parsed = VariableSetVariableName.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(422, { message: "variable set variable names must match ^[A-Z][A-Z0-9_]*$" });
  }
  assertAllowedVariableSetVariableName(parsed.data);
  return parsed.data;
}

function trimmedVariableSetName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new HTTPException(422, { message: "variable set name is required" });
  }
  return trimmed;
}
