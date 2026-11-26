import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// The app look is flat and solid (DESIGN.md "No decorative gradients"). Only the
// functional uses below may draw a gradient; each needs a reason. Adding a new one
// means adding it here with that reason, not reaching for a wash or glow.
const repo = `${import.meta.dir}/../../..`;

const ALLOWED: Record<string, { count: number; reason: string }> = {
  "packages/react/styles/app.css": {
    count: 2,
    reason: "solid hover layer (one colour twice) and the overflow fade mask on truncated rows",
  },
  "packages/react/styles/index.css": {
    count: 4,
    reason: "preview dot-lattice fallback, legacy loading shimmer text and the shimmer beam mask",
  },
  "packages/react/styles/connect.css": {
    count: 1,
    reason: "fade mask on the clipped plugin excerpt",
  },
  "packages/react/src/ui/line-tabs.tsx": { count: 1, reason: "edge fade mask on overflowing tabs" },
  "packages/react/src/ui/stat-tile.tsx": { count: 1, reason: "chart area fill" },
  "packages/react/src/components/machines/metric-history-chart.tsx": {
    count: 1,
    reason: "chart area fill",
  },
  "packages/react/src/components/machines/metric-sparkline.tsx": {
    count: 1,
    reason: "chart area fill",
  },
  "apps/web/src/components/insights/charts.tsx": { count: 1, reason: "chart area fill" },
  "packages/react/src/components/workspace-dock.tsx": {
    count: 1,
    reason: "overflow fade mask on the tab strip",
  },
  "packages/react/src/components/model-level-picker.tsx": {
    count: 1,
    reason: "fade mask on the label viewport",
  },
  "packages/react/src/meetings/live-transcript.tsx": {
    count: 1,
    reason: "fade mask on scrolled transcript text",
  },
  "apps/web/src/components/capabilities/plugin-page.tsx": {
    count: 1,
    reason: "fade mask on the clipped excerpt",
  },
  "packages/react/src/components/user-message-body.tsx": {
    count: 1,
    reason: "fade that hides the collapsed message overflow",
  },
  "apps/web/src/components/secrets/provider-marks.tsx": {
    count: 1,
    reason: "Proton Pass brand logo",
  },
  "packages/react/src/testing/session-scenarios.ts": {
    count: 1,
    reason: "fixture HTML for a user app preview",
  },
  "apps/api/src/routes/github-browser-pages.ts": {
    count: 2,
    reason: "solid hover layer on option rows",
  },
};

const GRADIENT =
  /(?:linear|radial|conic)-gradient\(|bg-gradient-|bg-(?:linear|radial|conic)-|<(?:linear|radial)Gradient\b|create(?:Linear|Radial|Conic)Gradient\(/g;

const roots = [
  "packages/react/styles",
  "packages/react/src",
  "apps/web/src",
  "packages/desktop/src/pages",
];
// Standalone pages styled like the app.
const pages = [
  "apps/web/public/checkout-complete.html",
  "apps/api/src/routes/github-browser-pages.ts",
];

function skipped(path: string): boolean {
  return (
    path.endsWith("compiled.css") ||
    path.endsWith("effective-tokens.css") ||
    /\.test\.tsx?$/.test(path) ||
    path.includes("/dev/") ||
    // Shipped into user-built visualizations, not the app's own chrome.
    path.includes("/visualization-assets")
  );
}

async function scan(): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const count = async (path: string) => {
    const hits = (await Bun.file(`${repo}/${path}`).text()).match(GRADIENT)?.length ?? 0;
    if (hits > 0) found.set(path, hits);
  };
  for (const root of roots) {
    for await (const file of new Glob("**/*.{css,ts,tsx}").scan({ cwd: `${repo}/${root}` })) {
      const path = `${root}/${file}`;
      if (!skipped(path)) await count(path);
    }
  }
  for (const path of pages) await count(path);
  return found;
}

describe("no decorative gradients in app styles", () => {
  test("only allow-listed functional gradients remain", async () => {
    const found = await scan();
    const unexpected = [...found].filter(([path, count]) => count > (ALLOWED[path]?.count ?? 0));
    expect(unexpected).toEqual([]);
  });

  test("the allow-list has no stale entries", async () => {
    const found = await scan();
    const stale = Object.keys(ALLOWED).filter((path) => !found.has(path));
    expect(stale).toEqual([]);
  });
});
