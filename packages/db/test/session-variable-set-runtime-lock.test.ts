import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

describe("session Variable Set runtime fence", () => {
  test("serializes replacement with first lease creation and holder publication", () => {
    const source = readFileSync(join(repoRoot, "packages/db/src/index.ts"), "utf8");
    const updateStart = source.indexOf("export async function updateSessionVariableSets(");
    const updateEnd = source.indexOf("export async function countRigs(", updateStart);
    const acquireStart = source.indexOf("async function acquireLeaseOnce(");
    const acquireEnd = source.indexOf("export async function acquireLease(", acquireStart);
    const dependencyReadStart = source.indexOf(
      "export async function countActiveSessionsUsingVariableSet(",
    );
    const dependencyReadEnd = source.indexOf(
      "export async function setVariableSetVariable(",
      dependencyReadStart,
    );
    const updateSource = source.slice(updateStart, updateEnd);
    const acquireSource = source.slice(acquireStart, acquireEnd);
    const dependencyReadSource = source.slice(dependencyReadStart, dependencyReadEnd);

    expect(updateSource).toContain("const locks = await lockSessionEventWriteRows");
    expect(updateSource).toContain("from ${schema.sessionTurns} turn_row");
    expect(updateSource).toContain("'queued', 'running', 'requires_action', 'recovering'");
    expect(updateSource).toContain("from ${schema.sessionTurnAttempts} attempt_row");
    expect(updateSource).toContain("from ${schema.sessionSystemUpdates} update_row");
    expect(updateSource).toContain("from ${schema.sessionGoals} goal_row");
    expect(updateSource).toContain("isSessionVariableSetSelectionFkViolation(error)");
    expect(updateSource).toContain("const current = await getVariableSet(");
    expect(updateSource).toContain('status: "invalid_variable_sets"');
    expect(updateSource.indexOf("lockSessionEventWriteRows")).toBeLessThan(
      updateSource.indexOf("from ${schema.sessionTurns} turn_row"),
    );
    expect(updateSource.indexOf("from ${schema.sessionTurns} turn_row")).toBeLessThan(
      updateSource.indexOf(".update(schema.sessions)"),
    );
    expect(updateSource).toContain(
      "await lockSandboxLeaseAdmission(tx, input.workspaceId, session.sandboxGroupId)",
    );
    expect(updateSource).toContain("from sandbox_leases");
    expect(updateSource).toContain("for update");
    expect(updateSource.indexOf("for update")).toBeLessThan(
      updateSource.indexOf("from sandbox_lease_holders holder"),
    );
    expect(acquireSource).toContain(
      "await lockSandboxLeaseAdmission(tx, workspaceId, sandboxGroupId)",
    );
    expect(acquireSource.indexOf("lockSandboxLeaseAdmission")).toBeLessThan(
      acquireSource.indexOf("insert into sandbox_leases"),
    );
    expect(dependencyReadSource).toContain("schema.sessions.variableSetIds");
    expect(dependencyReadSource).not.toContain("schema.sessionVariableSetAttachments");
  });

  test("translates only exact create selection foreign keys after rollback", () => {
    const source = readFileSync(join(repoRoot, "packages/db/src/index.ts"), "utf8");
    const routeSource = readFileSync(join(repoRoot, "apps/api/src/routes/sessions.ts"), "utf8");
    const classifierStart = source.indexOf("const sessionVariableSetSelectionFkConstraints");
    const classifierEnd = source.indexOf("function mapChannel(", classifierStart);
    const createStart = source.indexOf("export async function createSession(");
    const createEnd = source.indexOf(
      "export async function createSessionWithIdempotencyKeyResult(",
      createStart,
    );
    const keyedCreateStart = createEnd;
    const keyedCreateEnd = source.indexOf(
      "export async function createSessionWithIdempotencyKey(",
      keyedCreateStart,
    );
    const classifierSource = source.slice(classifierStart, classifierEnd);
    const constraintSetSource = classifierSource.slice(
      classifierSource.indexOf("["),
      classifierSource.indexOf("]);") + 2,
    );
    const createSource = source.slice(createStart, createEnd);
    const keyedCreateSource = source.slice(keyedCreateStart, keyedCreateEnd);

    expect(constraintSetSource.match(/"[^"]+"/g)).toEqual([
      '"sessions_environment_id_fkey"',
      '"session_variable_set_attachments_variable_set_id_fkey"',
    ]);
    expect(classifierSource).toContain('nestedPostgresSqlState(error) === "23503"');
    expect(classifierSource).toContain("sessionVariableSetSelectionFkConstraints.has(");
    expect(classifierSource).toContain("translateSessionVariableSetSelectionCreateError(");
    expect(classifierSource).toContain("subjectId: input.subjectId");
    expect(classifierSource).toContain("const current = await getVariableSet(");
    expect(classifierSource).toContain(
      "throw new SessionVariableSetSelectionUnavailableError(unavailableVariableSetIds, error)",
    );
    expect(createSource).toContain("translateSessionVariableSetSelectionCreateError(");
    expect(keyedCreateSource).toContain("translateSessionVariableSetSelectionCreateError(");
    expect(routeSource).toContain("error instanceof SessionVariableSetSelectionUnavailableError");
    expect(routeSource).toContain("details: { variableSetIds: error.variableSetIds }");
  });
});
