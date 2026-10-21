import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { computeMetricNames, selectedMetrics } from "./compute-metrics";

type Panel = {
  id: number;
  type: string;
  title?: string;
  description?: string;
  targets?: Array<{ expr?: string; legendFormat?: string }>;
};
type Dashboard = {
  uid: string;
  title: string;
  tags: string[];
  templating: { list: Array<{ name: string; query?: unknown; multi?: boolean }> };
  panels: Panel[];
};

async function dashboard(): Promise<Dashboard> {
  return JSON.parse(await readFile(new URL("./compute.json", import.meta.url), "utf8"));
}

const expressions = (board: Dashboard) =>
  board.panels.flatMap((panel) => (panel.targets ?? []).map((target) => target.expr ?? ""));

describe("compute dashboard", () => {
  test("is a canonical Opengeni board for one exact deployment", async () => {
    const board = await dashboard();
    expect(board.uid).toBe("opengeni-compute");
    expect(board.title).toBe("Opengeni · Compute");
    expect(board.tags).toEqual(expect.arrayContaining(["opengeni", "observability", "compute"]));
    const variables = board.templating.list.map((variable) => variable.name);
    expect(variables).toEqual(["datasource", "namespace", "release", "host"]);
    // "All" lists the release's hosts, never a regex matching other releases'.
    const host = board.templating.list.find((variable) => variable.name === "host") as {
      includeAll?: boolean;
      allValue?: string;
    };
    expect(host.includeAll).toBe(true);
    expect(host.allValue).toBeUndefined();
    const single = board.templating.list.filter((variable) =>
      ["namespace", "release"].includes(variable.name),
    );
    expect(single.every((variable) => !variable.multi)).toBe(true);
    expect(new Set(board.panels.map((panel) => panel.id)).size).toBe(board.panels.length);
    for (const panel of board.panels.filter((each) => each.type !== "row")) {
      expect(panel.description?.trim(), `${panel.title} description`).toBeTruthy();
      expect(panel.targets?.length, `${panel.title} targets`).toBeGreaterThan(0);
    }
  });

  test("queries only metrics compute emits", async () => {
    const emitted = computeMetricNames();
    expect(emitted.has("compute_fleet_host_info")).toBe(true);
    expect(emitted.has("compute_step_duration_seconds_bucket")).toBe(true);
    expect(emitted.has("compute_host_pressure_stall_microseconds_total")).toBe(true);
    for (const expr of expressions(await dashboard())) {
      for (const metric of selectedMetrics(expr)) {
        if (metric === "up") continue;
        expect(emitted.has(metric), `${metric} in ${expr}`).toBe(true);
      }
    }
  });

  test("finds metrics with matchers and bare ones, and nothing else", () => {
    expect(selectedMetrics("compute_control_leader == 0")).toEqual(["compute_control_leader"]);
    expect(
      selectedMetrics(
        'histogram_quantile(0.95, sum by (le, route) (rate(a_bucket{route="x"}[$__rate_interval]))) and on (host_name) b > bool 1e3',
      ),
    ).toEqual(["a_bucket", "b"]);
    expect(selectedMetrics('label_replace(c offset 5m, "dst", "$1", "src", "(.*)")')).toEqual([
      "c",
    ]);
  });

  test("names histograms by their series and counters with _total", () => {
    const emitted = computeMetricNames();
    expect(emitted.has("compute_control_request_duration_seconds")).toBe(false);
    expect(emitted.has("compute_control_request_duration_seconds_bucket")).toBe(true);
    expect(emitted.has("compute_step_count_total")).toBe(true);
    expect(emitted.has("compute_step_count")).toBe(false);
    expect(emitted.has("compute_sandbox_count")).toBe(true);
    expect(emitted.has("compute_sandbox_count_total")).toBe(false);
  });

  test("scopes every query to the selected deployment", async () => {
    for (const expr of expressions(await dashboard())) {
      const metrics = selectedMetrics(expr);
      // The control service's series carry the release's labels; a host's
      // carry only its name, which the host variable takes from the release's
      // compute_fleet_host_info.
      if (metrics.some((metric) => metric.startsWith("compute_control_") || metric === "up")) {
        expect(expr).toContain('namespace="$namespace",release="$release"');
      } else if (metrics.some((metric) => metric.startsWith("compute_fleet_"))) {
        expect(expr).toContain('namespace="$namespace",release="$release"');
      } else {
        expect(expr, expr).toContain('host_name=~"$host"');
      }
    }
  });

  test("groups by no sandbox, team or chat", async () => {
    const board = await dashboard();
    const legends = board.panels.flatMap((panel) =>
      (panel.targets ?? []).map((target) => target.legendFormat ?? ""),
    );
    for (const text of [...expressions(board), ...legends]) {
      expect(text).not.toMatch(/sandbox_id|team|session_id|workspace_id/);
    }
  });
});
