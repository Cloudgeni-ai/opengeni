import { describe, expect, test } from "bun:test";
import type * as Contracts from "@opengeni/contracts";
import { OpenGeniClient } from "../src/client";
import type * as Sdk from "../src/types";

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test("SDK Insights mirrors match contract output types in both directions", () => {
  // These assignments are checked by SDK typecheck, not merely Bun's runtime
  // transpiler. Missing private fields and number|null drift must fail here.
  const series: MutuallyAssignable<Sdk.InsightsSeriesPoint, Contracts.InsightsSeriesPoint> = true;
  const driver: MutuallyAssignable<Sdk.InsightsSpendDriver, Contracts.InsightsSpendDriver> = true;
  const snapshot: MutuallyAssignable<
    Sdk.WorkspaceInsightsSnapshot,
    Contracts.WorkspaceInsightsSnapshot
  > = true;
  const project: MutuallyAssignable<Sdk.InsightsProjectRow, Contracts.InsightsProjectRow> = true;
  const floor: MutuallyAssignable<Sdk.InsightsFloorSession, Contracts.InsightsFloorSession> = true;
  const schedule: MutuallyAssignable<Sdk.InsightsScheduleRow, Contracts.InsightsScheduleRow> = true;
  expect([series, driver, snapshot, project, floor, schedule]).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
});

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

  test("sends root-session and session scope as query parameters", async () => {
    let url = "";
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        url = new Request(input, init).url;
        return Response.json({ snapshot: {} });
      }) as typeof fetch,
    });
    await client.getWorkspaceInsights("workspace-one", {
      range: "month",
      rootSessionId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
    });
    expect(url).toBe(
      "https://api.example.test/v1/workspaces/workspace-one/insights?range=month&rootSessionId=11111111-1111-4111-8111-111111111111&sessionId=22222222-2222-4222-8222-222222222222",
    );
  });
});
