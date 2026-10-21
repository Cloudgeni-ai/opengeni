import { afterEach, describe, expect, test } from "bun:test";
import type { HumanInputQuestion, HumanInputSecretSpec } from "@opengeni/sdk";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

const { HumanInputForm } = await import("../src");
const { linkifySegments } = await import("../src/components/linkified-text");

const SIGN_IN_URL =
  "https://example.com/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference+user%3Aprofile&state=abc";

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

const secret: HumanInputSecretSpec = {
  item: "Sign-in code",
  field: "code",
  fieldKind: "concealed",
  itemType: "api_key",
  username: null,
  website: null,
  looksLike: null,
  pattern: null,
  saveTo: "task",
  vault: null,
  allowGenerate: false,
  generate: null,
  autocomplete: "one-time-code",
};

function question(overrides: Partial<HumanInputQuestion>): HumanInputQuestion {
  return {
    id: "code",
    kind: "text",
    prompt: "",
    options: [],
    required: true,
    allowOther: false,
    ...overrides,
  };
}

function links(container: HTMLElement): HTMLAnchorElement[] {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")];
}

describe("links in human-input questions", () => {
  test("splits bare URLs from surrounding text and sentence punctuation", () => {
    expect(linkifySegments(`Open ${SIGN_IN_URL}. Then paste the code.`)).toEqual([
      { kind: "text", value: "Open " },
      { kind: "link", value: SIGN_IN_URL },
      { kind: "text", value: ". Then paste the code." },
    ]);
    expect(linkifySegments("(see https://example.com/a_(b))")).toEqual([
      { kind: "text", value: "(see " },
      { kind: "link", value: "https://example.com/a_(b)" },
      { kind: "text", value: ")" },
    ]);
    expect(linkifySegments("no links here, ftp://x or javascript:alert(1)")).toEqual([
      { kind: "text", value: "no links here, ftp://x or javascript:alert(1)" },
    ]);
  });

  test("Markdown links render their label and keep the full URL as href", () => {
    expect(linkifySegments(`[Open authorization](${SIGN_IN_URL}) Then paste the code.`)).toEqual([
      { kind: "link", value: SIGN_IN_URL, label: "Open authorization" },
      { kind: "text", value: " Then paste the code." },
    ]);
    expect(linkifySegments("See [docs](https://example.com/a_(b)), or https://x.dev.")).toEqual([
      { kind: "text", value: "See " },
      { kind: "link", value: "https://example.com/a_(b)", label: "docs" },
      { kind: "text", value: ", or " },
      { kind: "link", value: "https://x.dev" },
      { kind: "text", value: "." },
    ]);
    // Unsafe or malformed targets stay plain text; no javascript: links.
    expect(linkifySegments("[x](javascript:alert(1)) [y] (z) [w](no spaces allowed)")).toEqual([
      { kind: "text", value: "[x](javascript:alert(1)) [y] (z) [w](no spaces allowed)" },
    ]);
  });

  test("help text Markdown links show the label, not raw syntax", async () => {
    mounted = await renderComponent(
      <HumanInputForm
        request={{
          id: "request-markdown",
          allowSkip: false,
          expiresAt: null,
          questions: [
            question({
              kind: "secret",
              label: "Code",
              prompt: "Finish sign-in",
              helpText: `[Open authorization](${SIGN_IN_URL}) Use this new link.`,
              secret,
            }),
          ],
        }}
        autoFocus={false}
        onSubmit={() => {}}
      />,
    );
    const anchors = links(mounted.container);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.textContent).toBe("Open authorization");
    expect(anchors[0]!.getAttribute("href")).toBe(SIGN_IN_URL);
    expect(mounted.container.textContent).not.toContain("](");
  });

  test("option descriptions are linked", async () => {
    mounted = await renderComponent(
      <HumanInputForm
        request={{
          id: "request-options",
          allowSkip: false,
          expiresAt: null,
          questions: [
            question({
              id: "pick",
              kind: "single_select",
              label: "Pick one",
              prompt: "Pick one",
              options: [
                { id: "a", label: "A", description: "See [pricing](https://example.com/p)" },
                { id: "b", label: "B", description: null },
              ],
            }),
          ],
        }}
        autoFocus={false}
        onSubmit={() => {}}
      />,
    );
    const anchor = links(mounted.container).find((a) => a.textContent === "pricing");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/p");
  });

  test("a pending secret question makes its sign-in URL clickable and wrappable", async () => {
    mounted = await renderComponent(
      <HumanInputForm
        request={{
          id: "request-sign-in",
          allowSkip: false,
          expiresAt: null,
          questions: [
            question({
              kind: "secret",
              label: "Sign-in code",
              prompt: `Open this link, sign in and approve. Then paste the code it shows here: ${SIGN_IN_URL}`,
              secret,
            }),
          ],
        }}
        autoFocus={false}
        onSubmit={() => {}}
      />,
    );
    const anchors = links(mounted.container);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("href")).toBe(SIGN_IN_URL);
    expect(anchors[0]!.getAttribute("target")).toBe("_blank");
    expect(anchors[0]!.getAttribute("rel")).toContain("noopener");
    expect(anchors[0]!.className).toContain("[overflow-wrap:anywhere]");
    expect(anchors[0]!.parentElement!.className).toContain("[overflow-wrap:anywhere]");
  });

  test("prompts and help text in a multi-question request are linked too", async () => {
    mounted = await renderComponent(
      <HumanInputForm
        request={{
          id: "request-many",
          allowSkip: false,
          expiresAt: null,
          questions: [
            question({ id: "a", label: "First", prompt: "See https://example.com/one" }),
            question({
              id: "b",
              prompt: "Docs at https://example.com/two?",
              helpText: "Details: https://example.com/three",
            }),
          ],
        }}
        autoFocus={false}
        onSubmit={() => {}}
      />,
    );
    expect(links(mounted.container).map((anchor) => anchor.getAttribute("href"))).toEqual([
      "https://example.com/one",
      "https://example.com/two",
      "https://example.com/three",
    ]);
  });
});
