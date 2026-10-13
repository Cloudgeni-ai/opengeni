import type { VaultApiError } from "@opengeni/contracts";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

const VARIABLE_SETS_REMOVED_MESSAGE =
  "Variable Sets were replaced by vaults. Save secrets with /v1/workspaces/{workspaceId}/vaults and choose a session's vaults with PUT /sessions/{sessionId}/vault-policy.";

/** The RM-1 answer for legacy Variable Set routes (410) and fields (422). */
export function variableSetsRemovedResponse(
  c: Context,
  status: 410 | 422,
  fields?: readonly string[],
): Response {
  const body: VaultApiError = {
    error: "variable_sets_removed",
    message: VARIABLE_SETS_REMOVED_MESSAGE,
    details: { vaultsPath: "/vaults", ...(fields?.length ? { fields: [...fields] } : {}) },
  };
  return c.json(body, status);
}

/** Thrown where a route cannot return directly; `app.onError` renders it. */
export class VariableSetsRemovedError extends Error {
  override readonly name = "VariableSetsRemovedError";
  constructor(readonly fields: readonly string[]) {
    super(`variable_sets_removed: ${fields.join(", ")}`);
  }
}

const CORE_VARIABLE_SETS_REMOVED = /^variable_sets_removed: (\S+) /;

/**
 * The RM-1 body for a removed-field error from a route or from core's
 * `variableSetsRemovedError`, or null for any other error.
 */
export function variableSetsRemovedErrorResponse(c: Context, error: unknown): Response | null {
  if (error instanceof VariableSetsRemovedError) {
    return variableSetsRemovedResponse(c, 422, error.fields);
  }
  if (error instanceof HTTPException && error.status === 422) {
    const field = CORE_VARIABLE_SETS_REMOVED.exec(error.message)?.[1];
    if (field) return variableSetsRemovedResponse(c, 422, [field]);
  }
  return null;
}

/**
 * Legacy selection fields that still carry a choice. Empty arrays and null
 * mean "no Variable Sets" and stay accepted so old clients keep working.
 */
export function legacyVariableSetFields(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const fields: string[] = [];
  for (const field of ["variableSetIds", "defaultVariableSetIds"] as const) {
    const ids = record[field];
    if (ids !== undefined && ids !== null && !(Array.isArray(ids) && ids.length === 0)) {
      fields.push(field);
    }
  }
  for (const field of ["variableSetId", "environmentId"] as const) {
    if (record[field] !== undefined && record[field] !== null) fields.push(field);
  }
  return fields;
}

/** True when the body explicitly clears a legacy selection (`null` or `[]`). */
export function clearsLegacyVariableSet(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return (
    (Object.hasOwn(record, "variableSetId") && record.variableSetId === null) ||
    (Object.hasOwn(record, "environmentId") && record.environmentId === null) ||
    (Array.isArray(record.variableSetIds) && record.variableSetIds.length === 0)
  );
}

const LEGACY_VARIABLE_SET_FIELDS = [
  "variableSetIds",
  "variableSetId",
  "environmentId",
  "defaultVariableSetIds",
] as const;

/**
 * Drops every (empty) legacy Variable Set field so nothing downstream can act
 * on one. Call after {@link legacyVariableSetFields} found none set.
 */
export function withoutLegacyVariableSetFields(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const rest: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of LEGACY_VARIABLE_SET_FIELDS) delete rest[field];
  return rest;
}

/**
 * The RM-1 boundary for one JSON body: a 422 `variable_sets_removed` response
 * when a legacy field still carries a choice, otherwise the body without them.
 */
export function rejectLegacyVariableSetFields(
  c: Context,
  payload: unknown,
): { response: Response } | { payload: unknown } {
  const fields = legacyVariableSetFields(payload);
  if (fields.length > 0) return { response: variableSetsRemovedResponse(c, 422, fields) };
  return { payload: withoutLegacyVariableSetFields(payload) };
}

/**
 * Old clients send `variableSetId: null` / `environmentId: null` to mean "no
 * Variable Sets". The create schema only takes the array form, so translate the
 * accepted empty legacy fields to it. Call after {@link legacyVariableSetFields}.
 */
export function withoutEmptyLegacyVariableSetFields(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (!Object.hasOwn(record, "variableSetId") && !Object.hasOwn(record, "environmentId")) {
    return payload;
  }
  const { variableSetId: _variableSetId, environmentId: _environmentId, ...rest } = record;
  return { ...rest, variableSetIds: rest.variableSetIds ?? [] };
}
