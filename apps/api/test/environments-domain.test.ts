import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { assertAllowedEnvironmentVariableName, requireEnvironmentEncryption } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";

describe("environment variable name policy", () => {
  test("rejects platform-managed exact names", () => {
    for (const name of [
      "HOME",
      "PATH",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITLAB_TOKEN",
      "AZURE_DEVOPS_EXT_PAT",
      "GIT_ASKPASS",
      "GIT_TERMINAL_PROMPT",
      "BASH_ENV",
      "ENV",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "PERL5OPT",
      "IFS",
    ]) {
      expect(() => assertAllowedEnvironmentVariableName(name)).toThrow(
        `reserved environment variable name: ${name}`,
      );
    }
  });

  test("rejects reserved prefixes", () => {
    for (const name of [
      "OPENGENI_DATABASE_URL",
      "GIT_CONFIG_COUNT",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      expect(() => assertAllowedEnvironmentVariableName(name)).toThrow(
        `reserved environment variable name: ${name}`,
      );
    }
  });

  test("allows ordinary uppercase names", () => {
    for (const name of ["DATABASE_URL", "STRIPE_API_KEY", "AZURE_CLIENT_ID", "MY_APP_TOKEN_2"]) {
      expect(() => assertAllowedEnvironmentVariableName(name)).not.toThrow();
    }
  });
});

describe("environment encryption guard", () => {
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
      testSettings({
        environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      }),
    );
    expect(key.length).toBe(32);
  });
});

describe("variable set attachment metadata surface", () => {
  test("uses attach/use authority without widening the metadata catalog permissions", async () => {
    const source = await Bun.file(new URL("../src/routes/environments.ts", import.meta.url)).text();
    const start = source.indexOf("app.post(`${prefix}/resolve-attachments`");
    const end = source.indexOf("app.get(`${prefix}/:variableSetId`", start);
    const resolver = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(resolver).toContain('requirePermission(grant, "variable-sets:attach")');
    expect(resolver).toContain('requirePermission(grant, "variable-sets:use")');
    expect(resolver).not.toContain('"variable-sets:list"');
    expect(resolver).not.toContain('"secrets:list"');
    expect(resolver).toContain("resolveVariableSetAttachments(");
    expect(resolver).not.toContain("Promise.all(");
    expect(resolver).not.toContain("getVariableSet(");
  });

  test("resolves requested ids set-wise in one transaction-pinned RLS scope", async () => {
    const source = await Bun.file(
      new URL("../../../packages/db/src/index.ts", import.meta.url),
    ).text();
    const start = source.indexOf("export async function resolveVariableSetAttachments(");
    const end = source.indexOf("export async function getVariableSet(", start);
    const resolver = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(resolver.match(/withRlsContext\(/gu)?.length).toBe(1);
    expect(resolver).toContain("setSubjectRlsContext(scopedDb, context.subjectId)");
    expect(resolver).toContain("unnest(${[...variableSetIds]}::uuid[]) with ordinality");
    expect(resolver).toContain("cross join lateral list_scoped_variable_sets(");
    expect(resolver).toContain("order by requested.ordinal");
    expect(resolver).not.toContain("Promise.all(");
    expect(resolver).not.toContain(".map(async");
  });
});
