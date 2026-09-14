import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

describe("workspace Insights requests", () => {
  test("forwards cancellation without putting the signal in query parameters", async () => {
    const controller = new AbortController();
    let request: Request | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        request = new Request(input, init);
        started();
        return await new Promise<Response>((_resolve, reject) => {
          request!.signal.addEventListener("abort", () => reject(request!.signal.reason), {
            once: true,
          });
        });
      }) as typeof fetch,
    });
    const pending = client.getWorkspaceInsights("workspace-one", {
      range: "ytd",
      provider: "provider-one",
      model: "model-one",
      signal: controller.signal,
    });
    await ready;
    expect(request!.url).toBe(
      "https://api.example.test/v1/workspaces/workspace-one/insights?range=ytd&provider=provider-one&model=model-one",
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(request!.signal.aborted).toBe(true);
  });

  test("preserves the default week request for existing callers", async () => {
    let url = "";
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        url = new Request(input, init).url;
        return Response.json({ snapshot: {} });
      }) as typeof fetch,
    });
    await client.getWorkspaceInsights("workspace-one");
    expect(url).toBe("https://api.example.test/v1/workspaces/workspace-one/insights?range=week");
  });
});
