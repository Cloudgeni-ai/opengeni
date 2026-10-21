import { expect, test } from "bun:test";
import { latestGreenMain } from "./latest-green-main";

test("latest-green discovery requires full success on the exact successful run", () => {
  const calls: string[] = [];
  const result = latestGreenMain("owner/repo", (path) => {
    calls.push(path);
    if (path.includes("/runs?"))
      return {
        workflow_runs: [
          {
            head_sha: "a".repeat(40),
            id: 3,
            run_attempt: 1,
            html_url: "https://example.invalid/runs/3",
          },
          {
            head_sha: "b".repeat(40),
            id: 2,
            run_attempt: 2,
            html_url: "https://example.invalid/runs/2",
          },
        ],
      };
    if (path.includes("/commits/" + "a".repeat(40)))
      return [
        { context: "Queue ready", state: "success", target_url: "https://example.invalid/runs/3" },
        { context: "Full CI", state: "success", target_url: "https://example.invalid/runs/other" },
      ];
    return [
      {
        context: "Full CI",
        state: "success",
        target_url: "https://example.invalid/runs/2/attempts/2",
        creator: { login: "github-actions[bot]" },
      },
    ];
  });
  expect(result).toMatchObject({ sha: "b".repeat(40), runId: 2, runAttempt: 2 });
  expect(calls[0]).toContain("branch=main&event=push&status=success");
});

test("missing full-green evidence is not replaced by queue success", () => {
  expect(() => latestGreenMain("owner/repo", () => ({ workflow_runs: [] }))).toThrow(
    "No successful full main CI receipt",
  );
});

test("stale attempt and non-Actions status creators are not full-green evidence", () => {
  for (const [creator, attempt] of [
    ["other", 2],
    ["github-actions[bot]", 1],
  ]) {
    expect(() =>
      latestGreenMain("owner/repo", (path) =>
        path.includes("/runs?")
          ? {
              workflow_runs: [
                {
                  head_sha: "a".repeat(40),
                  id: 1,
                  run_attempt: 2,
                  html_url: "https://example.invalid/runs/1",
                },
              ],
            }
          : [
              {
                context: "Full CI",
                state: "success",
                target_url: `https://example.invalid/runs/1/attempts/${attempt}`,
                creator: { login: creator },
              },
            ],
      ),
    ).toThrow("No successful full main CI receipt");
  }
});
