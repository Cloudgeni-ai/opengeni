import { afterEach, describe, expect, test } from "bun:test";
import {
  openGeniConsolePath,
  type HumanInputQuestion,
  type HumanInputSecretSpec,
} from "@opengeni/sdk";
import type { ReactNode } from "react";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

const { HumanInputForm, OpenGeniLinkProvider } = await import("../src");

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

function form(questions: HumanInputQuestion[], wrap?: (node: ReactNode) => ReactNode) {
  const node = (
    <HumanInputForm
      request={{ id: "request", allowSkip: false, expiresAt: null, questions }}
      autoFocus={false}
      onSubmit={() => {}}
    />
  );
  return renderComponent(<>{wrap ? wrap(node) : node}</>);
}

describe("links in human-input questions", () => {
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

  test("bare URLs drop sentence punctuation and keep balanced parentheses", async () => {
    mounted = await form([
      question({
        prompt: `Open ${SIGN_IN_URL}. Then see https://example.com/a_(b)).`,
        helpText: "Not links: ftp://x or javascript:alert(1)",
      }),
    ]);
    expect(links(mounted.container).map((anchor) => anchor.getAttribute("href"))).toEqual([
      SIGN_IN_URL,
      "https://example.com/a_(b)",
    ]);
    expect(mounted.container.textContent).toContain("Not links: ftp://x or javascript:alert(1)");
  });

  test("prompt, help text and option descriptions render bold, italics, code and links", async () => {
    mounted = await form([
      question({
        id: "recipe",
        kind: "single_select",
        label: "Recipe",
        prompt: "Which **recipe** do you want, *really*?",
        helpText: "Run `make dinner` or read [the guide](https://example.com/guide).",
        options: [
          {
            id: "soup",
            label: "Soup",
            description: "**Warm** and [quick](https://example.com/soup), uses `stock`",
          },
          { id: "salad", label: "Salad", description: null },
        ],
      }),
    ]);
    const root = mounted.container;
    expect([...root.querySelectorAll("strong")].map((node) => node.textContent)).toEqual([
      "recipe",
      "Warm",
    ]);
    expect(root.querySelector("em")?.textContent).toBe("really");
    expect([...root.querySelectorAll("code")].map((node) => node.textContent)).toEqual([
      "make dinner",
      "stock",
    ]);
    expect(links(root).map((anchor) => [anchor.textContent, anchor.getAttribute("href")])).toEqual([
      ["the guide", "https://example.com/guide"],
      ["quick", "https://example.com/soup"],
    ]);
    expect(root.textContent).not.toContain("**");
    expect(root.textContent).not.toContain("`");
    expect(root.textContent).not.toContain("](");
    // Inline runs only: the card's own paragraphs and labels hold no blocks.
    expect(root.querySelector("p p, label p, h2 p, label div, h2 div")).toBeNull();
  });

  test("an app-relative workspace link in help text is a clickable label", async () => {
    const path = "/workspaces/ws-1/artifacts/4f0c6c1e-2b7a-4d1e-9c3a-8e5f6a7b8c9d";
    const questions = [
      question({
        label: "Recipes",
        prompt: "Which one should I cook?",
        helpText: `[Open the cookbook](${path}). It has all three recipes.`,
      }),
    ];
    // As in the app: console paths resolve through the host's link resolver.
    mounted = await form(questions, (node) => (
      <OpenGeniLinkProvider
        resolveLink={(target) => {
          const href = openGeniConsolePath(target, "ws-1");
          return href ? { href } : null;
        }}
      >
        {node}
      </OpenGeniLinkProvider>
    ));
    const anchor = links(mounted.container).find((a) => a.textContent === "Open the cookbook");
    expect(anchor?.getAttribute("href")).toBe(path);
    expect(mounted.container.textContent).toContain("Open the cookbook. It has all three recipes.");
    expect(mounted.container.textContent).not.toContain(path);
    await mounted.unmount();

    // Without a resolver it never navigates on the host origin, still no raw syntax.
    mounted = await form(questions);
    expect(links(mounted.container)).toHaveLength(0);
    expect(mounted.container.textContent).toContain("Open the cookbook");
    expect(mounted.container.textContent).not.toContain(path);
  });

  test("artifact: links resolve through the nearest link provider, as in chat", async () => {
    const fileId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
    mounted = await form(
      [question({ prompt: `Is [the report](artifact:${fileId}) right?` })],
      (node) => (
        <OpenGeniLinkProvider
          resolveLink={(target) =>
            target.kind === "file" ? { href: `/files/${target.fileId}` } : null
          }
        >
          {node}
        </OpenGeniLinkProvider>
      ),
    );
    const anchor = links(mounted.container).find((a) => a.textContent === "the report");
    expect(anchor?.getAttribute("href")).toBe(`/files/${fileId}`);
  });

  test("unsafe link targets stay inert text, like in chat", async () => {
    mounted = await form([
      question({
        label: "Danger",
        prompt: "[Click me](javascript:alert(1)) please",
        helpText: "[Data](data:text/html,<b>x</b>) and [vb](vbscript:msgbox)",
        options: [],
      }),
    ]);
    const root = mounted.container;
    expect(links(root)).toHaveLength(0);
    expect(root.querySelector('[href^="javascript:"], [href^="data:"], [href^="vbscript:"]')).toBe(
      null,
    );
    expect(root.textContent).toContain("Click me");
    expect(root.textContent).not.toContain("javascript:");
  });

  test("paragraphs and lists flow into line breaks inside the card text", async () => {
    mounted = await form([
      question({
        label: "Plan",
        prompt: "First paragraph.\n\n- one\n- two\n\nLast line\nnext line",
      }),
    ]);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("First paragraph.");
    expect(text).toContain("• one");
    expect(text).toContain("• two");
    expect(mounted.container.querySelector("ul, li, p p")).toBeNull();
    // Paragraph, two list items and one soft line break.
    expect(mounted.container.querySelectorAll("br")).toHaveLength(4);
  });
});
