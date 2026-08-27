import { describe, expect, test } from "bun:test";
import type { Observability } from "@opengeni/observability";
import {
  observeWorkDiscovery,
  summarizeWorkDiscoveryRows,
} from "../src/work-discovery-observability";

describe("work discovery observability", () => {
  test("records only bounded aggregate labels and stable match classes", () => {
    const calls: Array<Record<string, unknown>> = [];
    const observability = {
      incrementCounter: (input: Record<string, unknown>) => calls.push(input),
      observeHistogram: (input: Record<string, unknown>) => calls.push(input),
    } as unknown as Observability;
    const rows = [
      {
        relatedWork: {
          possibleOverlap: true,
          match: { class: "exact_subject" as const },
        },
      },
      {
        relatedWork: {
          possibleOverlap: true,
          match: { class: "title" as const },
        },
      },
      {
        relatedWork: { possibleOverlap: false, match: null },
      },
    ];

    observeWorkDiscovery(observability, {
      surface: "agent_topology",
      mode: "query",
      outcome: "ok",
      authorizationScope: "scoped",
      durationMs: 12,
      responseBytes: 4_096,
      ...summarizeWorkDiscoveryRows(rows),
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "opengeni_work_discovery_requests_total",
          labels: {
            surface: "agent_topology",
            mode: "query",
            outcome: "ok",
            authorization_scope: "scoped",
          },
        }),
        expect.objectContaining({
          name: "opengeni_work_discovery_matches_total",
          labels: { surface: "agent_topology", mode: "query", match_class: "exact_subject" },
          amount: 1,
        }),
        expect.objectContaining({
          name: "opengeni_work_discovery_matches_total",
          labels: { surface: "agent_topology", mode: "query", match_class: "title" },
          amount: 1,
        }),
      ]),
    );
    expect(JSON.stringify(calls)).not.toContain("workspaceId");
    expect(JSON.stringify(calls)).not.toContain("sessionId");
    expect(JSON.stringify(calls)).not.toContain("canonicalKey");
  });

  test("never lets a registry failure change discovery behavior", () => {
    const observability = {
      incrementCounter: () => {
        throw new Error("registry unavailable");
      },
      observeHistogram: () => {
        throw new Error("registry unavailable");
      },
    } as unknown as Observability;

    expect(() =>
      observeWorkDiscovery(observability, {
        surface: "first_party_mcp",
        mode: "browse",
        outcome: "empty",
        authorizationScope: "workspace",
        durationMs: 1,
        responseBytes: 128,
        resultCount: 0,
        overlapCount: 0,
        matchCounts: {},
      }),
    ).not.toThrow();
  });
});
