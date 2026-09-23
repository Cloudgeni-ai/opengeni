import { expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

test("the retired search path never invokes the old document retrieval lane", async () => {
  const settings = testSettings({ productAccessMode: "managed" });
  const workspaceId = crypto.randomUUID();
  const authorization = `Bearer ${await signDelegatedAccessToken(settings.delegationSecret!, {
    accountId: crypto.randomUUID(),
    workspaceId,
    subjectId: "user:knowledge-search",
    permissions: ["documents:search"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const app = createApp({
    settings,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const response = await app.request(`/v1/workspaces/${workspaceId}/knowledge/search`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ query: "retired path", limit: 50 }),
  });
  expect(response.status).toBe(410);
});
