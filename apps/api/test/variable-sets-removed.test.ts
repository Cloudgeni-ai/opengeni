import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireEnvironmentEncryption, variableSetsRemovedError } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import {
  legacyVariableSetFields,
  rejectLegacyVariableSetFields,
  VariableSetsRemovedError,
  variableSetsRemovedErrorResponse,
  withoutLegacyVariableSetFields,
} from "../src/http/variable-sets-removed";
import { registerVariableSetsRemovedRoutes } from "../src/routes/variable-sets-removed";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SET = "00000000-0000-4000-8000-000000000002";

describe("RM-1 legacy Variable Set routes", () => {
  const app = new Hono();
  registerVariableSetsRemovedRoutes(app);

  for (const [method, path] of [
    ["GET", `/v1/workspaces/${WORKSPACE}/variable-sets`],
    ["POST", `/v1/workspaces/${WORKSPACE}/variable-sets`],
    ["GET", `/v1/workspaces/${WORKSPACE}/variable-sets/${SET}`],
    ["PUT", `/v1/workspaces/${WORKSPACE}/variable-sets/${SET}/variables/API_KEY`],
    ["POST", `/v1/workspaces/${WORKSPACE}/variable-sets/resolve-attachments`],
    ["GET", `/v1/workspaces/${WORKSPACE}/environments`],
    ["DELETE", `/v1/workspaces/${WORKSPACE}/environments/${SET}`],
  ] as const) {
    test(`${method} ${path.replace(WORKSPACE, ":ws")} answers 410 variable_sets_removed`, async () => {
      const response = await app.request(path, { method });
      expect(response.status).toBe(410);
      const body = (await response.json()) as { error: string; details: { vaultsPath: string } };
      expect(body.error).toBe("variable_sets_removed");
      expect(body.details.vaultsPath).toBe("/vaults");
    });
  }
});

describe("RM-1 legacy Variable Set fields", () => {
  test("only fields that still carry a choice are legacy", () => {
    expect(legacyVariableSetFields({ variableSetIds: [], variableSetId: null })).toEqual([]);
    expect(legacyVariableSetFields({ environmentId: null, defaultVariableSetIds: [] })).toEqual([]);
    expect(
      legacyVariableSetFields({
        variableSetIds: [SET],
        variableSetId: SET,
        environmentId: SET,
        defaultVariableSetIds: [SET],
      }),
    ).toEqual(["variableSetIds", "defaultVariableSetIds", "variableSetId", "environmentId"]);
    expect(legacyVariableSetFields(null)).toEqual([]);
    expect(legacyVariableSetFields([SET])).toEqual([]);
  });

  test("empty legacy fields are stripped so nothing downstream acts on them", () => {
    expect(
      withoutLegacyVariableSetFields({
        name: "x",
        variableSetIds: [],
        variableSetId: null,
        environmentId: null,
        defaultVariableSetIds: [],
      }),
    ).toEqual({ name: "x" });
  });

  test("a body with a set choice is refused with 422 and the field names", async () => {
    const app = new Hono();
    app.post("/x", async (c) => {
      const result = rejectLegacyVariableSetFields(c, await c.req.json());
      if ("response" in result) return result.response;
      return c.json(result.payload);
    });
    const refused = await app.request("/x", {
      method: "POST",
      body: JSON.stringify({ name: "x", variableSetId: SET }),
      headers: { "content-type": "application/json" },
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: "variable_sets_removed",
      details: { fields: ["variableSetId"] },
    });
    const accepted = await app.request("/x", {
      method: "POST",
      body: JSON.stringify({ name: "x", variableSetId: null }),
      headers: { "content-type": "application/json" },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ name: "x" });
  });

  test("internal callers get a 422 naming the field", () => {
    const error = variableSetsRemovedError("defaultVariableSetIds");
    expect(error.status).toBe(422);
    expect(error.message).toContain("variable_sets_removed");
    expect(error.message).toContain("defaultVariableSetIds");
  });
});

describe("RM-1 thrown errors", () => {
  const app = new Hono();
  app.get("/route", () => {
    throw new VariableSetsRemovedError(["defaultVariableSetIds"]);
  });
  app.get("/core", () => {
    throw variableSetsRemovedError("variableSetId");
  });
  app.get("/other", () => {
    throw new HTTPException(422, { message: "something else" });
  });
  app.onError(
    (error, c) => variableSetsRemovedErrorResponse(c, error) ?? c.json({ error: "other" }, 500),
  );

  for (const [path, field] of [
    ["/route", "defaultVariableSetIds"],
    ["/core", "variableSetId"],
  ] as const) {
    test(`${path} renders the RM-1 body naming ${field}`, async () => {
      const response = await app.request(path);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "variable_sets_removed",
        details: { fields: [field] },
      });
    });
  }

  test("other 422s are left to the central handler", async () => {
    expect((await app.request("/other")).status).toBe(500);
  });
});

describe("encryption key guard", () => {
  test("returns 503 when the deployment has no encryption key", () => {
    try {
      requireEnvironmentEncryption(testSettings());
      throw new Error("expected requireEnvironmentEncryption to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPException);
      expect((error as HTTPException).status).toBe(503);
      expect((error as HTTPException).message).toContain("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
    }
  });

  test("returns the 32-byte key when configured", () => {
    const key = requireEnvironmentEncryption(
      testSettings({ environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64") }),
    );
    expect(key.length).toBe(32);
  });
});
