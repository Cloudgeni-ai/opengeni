import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PersonalWorkspaceBadge } from "./personal-workspace-badge";

describe("Personal workspace badge", () => {
  test("renders visible shorthand plus screen-reader text without an unsupported span label", () => {
    const markup = renderToStaticMarkup(<PersonalWorkspaceBadge />);
    expect(markup).toContain('aria-hidden="true">Personal</span>');
    expect(markup).toContain('class="sr-only"> Personal workspace</span>');
    expect(markup).not.toContain("aria-label");
  });

  test("can stay visible without duplicating an explicitly named parent control", () => {
    const markup = renderToStaticMarkup(<PersonalWorkspaceBadge decorative />);
    expect(markup).toContain("Personal</span>");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("aria-label");
    expect(markup).not.toContain("sr-only");
  });
});
