import { expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { recordSkillRead } from "../src/observability-metrics";

function series(metrics: string, labels: Record<string, string>): number | null {
  const line = metrics
    .split("\n")
    .find(
      (entry) =>
        entry.startsWith("opengeni_skill_reads_total{") &&
        Object.entries(labels).every(([key, value]) => entry.includes(`${key}="${value}"`)),
    );
  return line ? Number(line.split(" ").at(-1)) : null;
}

test("skill reads are counted by bounded source, built-in id, kind, and caller", async () => {
  const observability = createObservability(testSettings(), { component: "worker" });
  const reads = [
    { caller: "model", kind: "full", source: "builtin", skill: "builtin:opengeni-documents" },
    { caller: "model", kind: "full", source: "builtin", skill: "builtin:opengeni-documents" },
    {
      caller: "model",
      kind: "already_in_context",
      source: "builtin",
      skill: "builtin:opengeni-documents",
    },
    { caller: "codemode", kind: "files", source: "builtin", skill: "builtin:opengeni-help" },
    {
      caller: "model",
      kind: "list",
      source: "workspace",
      skill: "3f0d0c6e-7d67-4a38-9f8c-0f5fd6b8a0d1",
    },
    {
      caller: "model",
      kind: "full",
      source: "session",
      skill: "session:6c1f0f0a-0000-4000-8000-000000000000:quarterly-close",
    },
    // A same-named custom Skill is still custom.
    { caller: "model", kind: "full", source: "personal", skill: "builtin:opengeni-help" },
    // Refused before resolution: a built-in by id or plain name keeps its id.
    { caller: "model", kind: "refused", source: null, skill: "opengeni-sites" },
    { caller: "model", kind: "refused", source: null, skill: "builtin:opengeni-skills" },
    { caller: "model", kind: "refused", source: null, skill: "Acme payroll secrets" },
    { caller: "model", kind: "refused", source: null, skill: "builtin:not-a-built-in" },
  ] as const;
  for (const read of reads) recordSkillRead(observability, read);
  const metrics = await observability.prometheusMetrics();

  expect(
    series(metrics, {
      source: "builtin",
      skill: "builtin:opengeni-documents",
      kind: "full",
      caller: "model",
    }),
  ).toBe(2);
  expect(
    series(metrics, {
      source: "builtin",
      skill: "builtin:opengeni-documents",
      kind: "already_in_context",
    }),
  ).toBe(1);
  expect(
    series(metrics, { skill: "builtin:opengeni-help", kind: "files", caller: "codemode" }),
  ).toBe(1);
  expect(series(metrics, { source: "workspace", skill: "custom", kind: "list" })).toBe(1);
  expect(series(metrics, { source: "session", skill: "custom", kind: "full" })).toBe(1);
  expect(series(metrics, { source: "personal", skill: "custom", kind: "full" })).toBe(1);
  expect(
    series(metrics, { source: "unknown", skill: "builtin:opengeni-sites", kind: "refused" }),
  ).toBe(1);
  expect(
    series(metrics, { source: "unknown", skill: "builtin:opengeni-skills", kind: "refused" }),
  ).toBe(1);
  expect(series(metrics, { source: "unknown", skill: "custom", kind: "refused" })).toBe(2);

  const readLabels = new Set(["source", "skill", "kind", "caller"]);
  const labelValues = new Set(
    [...metrics.matchAll(/opengeni_skill_reads_total\{([^}]*)\}/g)].flatMap((match) =>
      [...match[1]!.matchAll(/(\w+)="([^"]*)"/g)]
        .filter((pair) => readLabels.has(pair[1]!))
        .map((pair) => pair[2]!),
    ),
  );
  expect([...labelValues].sort()).toEqual(
    [
      "already_in_context",
      "builtin",
      "builtin:opengeni-documents",
      "builtin:opengeni-help",
      "builtin:opengeni-sites",
      "builtin:opengeni-skills",
      "codemode",
      "custom",
      "files",
      "full",
      "list",
      "model",
      "personal",
      "refused",
      "session",
      "unknown",
      "workspace",
    ].sort(),
  );
  for (const raw of ["3f0d0c6e", "quarterly-close", "Acme", "not-a-built-in"]) {
    expect(metrics).not.toContain(raw);
  }
});
