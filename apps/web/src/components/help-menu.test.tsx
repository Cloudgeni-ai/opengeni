import { describe, expect, test } from "bun:test";
import { DropdownMenu as Primitive } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";

import { HelpMenu } from "@/components/help-menu";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { documentationLinkFromClientConfig } from "@/lib/documentation-link";

function renderHelpMenu(documentationUrl: string | null | undefined): string {
  return renderToStaticMarkup(
    <DropdownMenu open>
      <Primitive.Content forceMount>
        <HelpMenu documentationUrl={documentationUrl} itemClassName="min-h-11" />
      </Primitive.Content>
    </DropdownMenu>,
  );
}

describe("documentation link client config", () => {
  test("uses the deployment's advertised documentation URL", () => {
    expect(
      documentationLinkFromClientConfig({ documentationUrl: "https://docs.opengeni.ai" }),
    ).toBe("https://docs.opengeni.ai/");
    expect(
      documentationLinkFromClientConfig({ documentationUrl: "http://docs.internal.test/opengeni" }),
    ).toBe("http://docs.internal.test/opengeni");
  });

  test("shows no link when the deployment hides it or predates the field", () => {
    expect(documentationLinkFromClientConfig({ documentationUrl: null })).toBeNull();
    expect(documentationLinkFromClientConfig({})).toBeNull();
  });

  test("never turns a non-http(s) value into a link", () => {
    for (const documentationUrl of ["javascript:alert(1)", "data:text/html,x", "/docs", ""]) {
      expect(documentationLinkFromClientConfig({ documentationUrl })).toBeNull();
    }
  });
});

describe("account menu Help section", () => {
  test("opens the configured documentation in a new tab", () => {
    const markup = renderHelpMenu("https://docs.example.test/");
    expect(markup).toContain(">Help<");
    expect(markup).toContain('role="menuitem"');
    expect(markup).toContain('href="https://docs.example.test/"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Documentation");
    expect(markup).toContain("(opens in a new tab)");
    expect(markup).toContain("min-h-11");
  });

  test("renders nothing when the deployment publishes no documentation", () => {
    for (const documentationUrl of [null, undefined, "javascript:alert(1)"]) {
      const markup = renderHelpMenu(documentationUrl);
      expect(markup).not.toContain("Help");
      expect(markup).not.toContain("Documentation");
      expect(markup).not.toContain("<a");
    }
  });
});
