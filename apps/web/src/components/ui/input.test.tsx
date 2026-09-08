import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Input } from "./input";

describe("Input autofill", () => {
  test("explicitly suppresses identity suggestions for resource names", () => {
    const html = renderToStaticMarkup(<Input suppressAutofill id="resource-name" />);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('data-1p-ignore="true"');
    expect(html).toContain('data-lpignore="true"');
    expect(html).not.toContain("suppressAutofill");
  });

  test("preserves personal and credential autocomplete", () => {
    for (const autoComplete of ["name", "email", "username", "current-password", "new-password"]) {
      const html = renderToStaticMarkup(<Input autoComplete={autoComplete} />);
      expect(html).toContain(`autoComplete="${autoComplete}"`);
      expect(html).not.toContain("data-1p-ignore");
      expect(html).not.toContain("data-lpignore");
    }
  });

  test("does not change ordinary inputs unless opted in", () => {
    const html = renderToStaticMarkup(<Input type="password" autoComplete="off" />);
    expect(html).not.toContain("data-1p-ignore");
  });
});
