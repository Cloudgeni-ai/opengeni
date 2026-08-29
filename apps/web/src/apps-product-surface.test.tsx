import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AppsRoute } from "@/routes/apps";

const appSource = await Bun.file(`${import.meta.dir}/App.tsx`).text();
const navigationSource = await Bun.file(
  `${import.meta.dir}/components/rail/workspace-nav-data.ts`,
).text();

describe("Apps product surface", () => {
  test("registers list, detail, and run routes without replacing Artifacts", () => {
    expect(appSource).toContain('path: "apps"');
    expect(appSource).toContain('path: "apps/$appId"');
    expect(appSource).toContain('path: "apps/$appId/run"');
    expect(appSource).toContain('path: "artifacts"');
    expect(navigationSource).toContain('label: "Apps"');
    expect(navigationSource).toContain('label: "Artifacts"');
  });

  test("fails closed with an honest unavailable state until a transport is injected", () => {
    const markup = renderToStaticMarkup(<AppsRoute workspaceId="workspace-1" />);
    expect(markup).toContain("Apps are not connected in this host");
    expect(markup).toContain("HTTP, Code Mode");
  });
});
