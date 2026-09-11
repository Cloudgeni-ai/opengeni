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
