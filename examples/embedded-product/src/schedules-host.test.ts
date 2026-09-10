import { expect, test } from "bun:test";
import { OpenGeniClient } from "@opengeni/sdk";
import { createHostHandler } from "./host-handler";

test("host file upload scopes API calls to the actor and never sends credentials to storage", async () => {
  const calls: string[] = [];
  const fileId = crypto.randomUUID();
  const service = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      const target = new URL(String(url));
      calls.push(target.pathname);
      const headers = new Headers(init?.headers);
      if (target.origin === "https://storage.invalid") {
        expect(init?.method).toBe("PUT");
        expect(init?.credentials).toBe("omit");
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("x-opengeni-external-actor")).toBe(false);
        expect(await new Response(init?.body).text()).toBe("hello");
        return new Response(null, { status: 200 });
      }
      expect(
        JSON.parse(decodeURIComponent(headers.get("x-opengeni-external-actor")!)),
      ).toMatchObject({ identity: { externalId: "host-user" } });
      if (target.pathname.endsWith("/files/uploads")) {
        const input = JSON.parse(String(init?.body));
        expect(input).toMatchObject({
          filename: "hello.txt",
          contentType: "text/plain",
          sizeBytes: 5,
        });
        expect(input.sha256).toBe(
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        );
        return Response.json({
          uploadId: "fixture-upload",
          putUrl: "https://storage.invalid/object",
          requiredHeaders: { "content-type": "text/plain" },
        });
      }
      expect(target.pathname).toBe(
        "/v1/workspaces/host-workspace/files/uploads/fixture-upload/complete",
      );
      return Response.json({ file: { id: fileId, filename: "hello.txt", status: "ready" } });
    },
  });
  const handler = createHostHandler({
    service,
    authenticate: async () => ({
      workspaceId: "host-workspace",
      externalId: "host-user",
      source: "host",
    }),
    authorizeMutation: async () => true,
    returnUrl: () => "https://host.example",
    siteHref: () => "https://host.example",
  });
  const response = await handler(
    new Request("https://host.example/api/files/upload", {
      method: "POST",
      body: JSON.stringify({
        filename: "hello.txt",
        contentType: "text/plain",
        base64: "aGVsbG8=",
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: fileId, status: "ready" });
  expect(calls).toEqual([
    "/v1/workspaces/host-workspace/files/uploads",
    "/object",
    "/v1/workspaces/host-workspace/files/uploads/fixture-upload/complete",
  ]);
});

test("host schedules preserve actor scope and trigger identity; malformed uploads have no side effects", async () => {
  const calls: { path: string; body: unknown; actor: unknown }[] = [];
  const service = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        actor: JSON.parse(
          decodeURIComponent(new Headers(init?.headers).get("x-opengeni-external-actor")!),
        ),
      });
      return Response.json({});
    },
  });
  const handler = createHostHandler({
    service,
    authenticate: async () => ({
      workspaceId: "host-workspace",
      externalId: "host-user",
      source: "host",
    }),
    authorizeMutation: async () => true,
    returnUrl: () => "https://host.example",
    siteHref: () => "https://host.example",
  });
  const request = (path: string, body: unknown) =>
    handler(
      new Request(`https://host.example/api/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  const create = {
    name: "Review",
    prompt: "Review new work",
    model: "fixture-model",
    schedule: { type: "interval", everySeconds: 3600 },
  };
  expect((await request("schedules", create)).status).toBe(200);
  expect(calls[0]).toMatchObject({
    path: "/v1/workspaces/host-workspace/scheduled-tasks",
    body: {
      name: "Review",
      agentConfig: { prompt: "Review new work", model: "fixture-model" },
      status: "paused",
    },
    actor: { mode: "external", identity: { externalId: "host-user", source: "host" } },
  });
  const triggerId = crypto.randomUUID();
  expect((await request("schedules/task/trigger", { triggerId })).status).toBe(200);
  expect(calls[1]).toMatchObject({
    path: "/v1/workspaces/host-workspace/scheduled-tasks/task/trigger",
    body: { triggerId },
  });
  expect((await request("schedules/task/trigger", {})).status).toBe(400);
  expect((await request("schedules", { ...create, actorSubjectId: "forged" })).status).toBe(400);
  expect((await request("schedules/task/arbitrary", {})).status).toBe(404);
  expect(
    (
      await request("files/upload", {
        filename: "test.txt",
        contentType: "text/plain",
        base64: "invalid?",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("files/upload", {
        filename: "test.txt",
        contentType: "text/plain",
        base64: Buffer.alloc(32_769).toString("base64"),
      })
    ).status,
  ).toBe(413);
  expect(calls).toHaveLength(2);
});
