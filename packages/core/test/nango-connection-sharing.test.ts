import { describe, expect, test } from "bun:test";
import {
  NANGO_DEPLOYMENT_TAG,
  nangoAttemptTags,
  nangoDeploymentTag,
  type ConnectionMetadata,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import {
  listPersonNangoConnections,
  nangoAccountLabelOf,
  nangoConnectionIdOf,
  releaseNangoConnections,
  sweepNangoConnections,
} from "../src";

const settings = testSettings({
  nangoSecretKey: "nango-secret-test",
  nangoApiBaseUrl: "https://nango.test",
});

/** A database whose every organization read fails, as when a read is refused or times out. */
function unreadableDb(): Database {
  const tx = {
    execute: async () => [],
    transaction: async () => {
      throw new Error("unreadable");
    },
  };
  return {
    transaction: async (fn: (handle: unknown) => Promise<unknown>) => await fn(tx),
  } as unknown as Database;
}

function fakeNango(connections: Array<Record<string, unknown>>) {
  const deletes: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "DELETE") {
      deletes.push(decodeURIComponent(url.pathname.split("/").at(-1)!));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/connections") return Response.json({ connections });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { deletes, fetchImpl };
}

const owner = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  subjectId: "user:person",
};

describe("one Nango connection per person and account", () => {
  test("an organization that cannot be read makes the person's list incomplete", async () => {
    const person = await listPersonNangoConnections(unreadableDb(), {
      subjectId: owner.subjectId,
      knownWorkspaceIds: [owner.workspaceId],
    });
    expect(person).toEqual({ rows: [], complete: false, readFailed: true });
  });

  test("nothing is deleted for a person whose rows cannot all be read", async () => {
    const nango = fakeNango([
      {
        connection_id: "old-unused",
        provider_config_key: "google-mail",
        created: "2026-11-01T00:00:00.000Z",
        tags: {
          ...nangoAttemptTags({ ...owner, attemptId: "attempt", integrationKey: "gmail" }),
          [NANGO_DEPLOYMENT_TAG]: nangoDeploymentTag(settings)!,
        },
        errors: [],
      },
    ]);
    const deps = { db: unreadableDb(), settings, fetchImpl: nango.fetchImpl };
    expect(await sweepNangoConnections(deps)).toMatchObject({
      listed: 1,
      skippedPeople: 1,
      deletedOrphans: [],
    });
    expect(
      await releaseNangoConnections(deps, {
        subjectId: owner.subjectId,
        providerConfigKey: "google-mail",
        nangoConnectionIds: ["old-unused"],
      }),
    ).toEqual({ deleted: [], kept: ["old-unused"] });
    // A failed read is not a membership merely not active: even a fresh
    // attempt's connection is kept, since its own store may be unreadable.
    expect(
      await releaseNangoConnections(deps, {
        subjectId: owner.subjectId,
        providerConfigKey: "google-mail",
        nangoConnectionIds: ["old-unused"],
        freshAttempt: true,
      }),
    ).toEqual({ deleted: [], kept: ["old-unused"] });
    expect(nango.deletes).toEqual([]);
  });

  test("without a Nango secret key nothing is swept", async () => {
    expect(
      await sweepNangoConnections({
        db: unreadableDb(),
        settings: testSettings({ nangoSecretKey: undefined }),
      }),
    ).toBeNull();
  });

  test("a row's Nango connection and verified account", () => {
    const row = {
      metadata: {
        integrationBackend: "nango",
        nangoConnectionId: "nc-1",
        accountEmail: "person@example.com",
      },
    } as unknown as ConnectionMetadata;
    expect(nangoConnectionIdOf(row)).toBe("nc-1");
    expect(nangoAccountLabelOf(row)).toBe("person@example.com");
    const native = { metadata: { nangoConnectionId: "nc-1" } } as unknown as ConnectionMetadata;
    expect(nangoConnectionIdOf(native)).toBeNull();
    expect(nangoAccountLabelOf(native)).toBeNull();
  });
});
