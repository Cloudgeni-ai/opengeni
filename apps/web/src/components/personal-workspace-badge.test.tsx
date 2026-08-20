import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PersonalWorkspaceBadge } from "./personal-workspace-badge";

describe("Personal workspace badge", () => {
  test("is visible and exposes an unambiguous accessible name", () => {
    const markup = renderToStaticMarkup(<PersonalWorkspaceBadge />);
    expect(markup).toContain("Personal</span>");
    expect(markup).toContain('aria-label="Personal workspace"');
  });

  test("can stay visible without duplicating an explicitly named parent control", () => {
    const markup = renderToStaticMarkup(<PersonalWorkspaceBadge decorative />);
    expect(markup).toContain("Personal</span>");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("aria-label");
  });
});
