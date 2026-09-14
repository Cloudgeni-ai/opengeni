import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { prepareKnowledgeFile } from "../src/knowledge";

test("agent file preparation uses its focused SDK surface", async () => {
  let request: Request | undefined;
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: (async (url, init) => {
      request = new Request(url, init);
      return Response.json({ status: "disabled", fileId: "00000000-0000-4000-8000-000000000002" });
    }) as typeof fetch,
  });
  const result = await prepareKnowledgeFile(
    client,
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  );
  expect(request?.method).toBe("POST");
  expect(request?.url).toEndWith("/knowledge/files/00000000-0000-4000-8000-000000000002/prepare");
  expect(result.status).toBe("disabled");
  expect("prepareKnowledgeFile" in client).toBe(false);
});

test("save preparation preserves query and catalog continuation on the focused read surface", async () => {
  const { prepareKnowledgeSave } = await import("../src/knowledge");
  let request: Request | undefined;
  const response = {
    collections: {
      entries: [],
      complete: true,
      nextCursors: { published: null, needs_review: null },
    },
    matches: {
      published: { entries: [], nextCursor: null },
      needs_review: { entries: [], nextCursor: null },
    },
  };
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: (async (url, init) => {
      request = new Request(url, init);
      return Response.json(response);
    }) as typeof fetch,
  });
  const input = {
    query: "plugin dialog consistency",
    collectionCursors: { published: "cursor", needs_review: null },
  };
  expect(await prepareKnowledgeSave(client, "workspace", input)).toEqual(response);
  expect(request?.method).toBe("POST");
  expect(request?.url).toEndWith("/knowledge/entries/prepare-save");
  expect(await request?.json()).toEqual(input);
});
