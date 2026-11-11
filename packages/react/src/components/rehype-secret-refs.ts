import type { SecretTextTokenLike } from "../secrets-ui";

/* Turn secret references in rendered Markdown into chip placeholders
   (`<span data-og-secret-ref="{{secret:…}}">`), which the Markdown `span`
   renderer draws as a SecretRefChip.

   Where references become chips:
   - prose text (paragraphs, lists, tables, headings, emphasis);
   - inline code whose whole content is exactly one reference, because the
     agent often writes `{{secret:GitHub/password}}` in backticks and the chip
     says the same thing more clearly.
   Where they stay literal:
   - fenced code blocks and inline code with anything else in it, so code reads
     and copies exactly as written;
   - link text, so a chip never nests inside a link.

   Structural hast types keep the module dependency-free, like stream-reveal. */

type HastText = { type: "text"; value: string; position?: unknown };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChild[];
};
type HastChild = HastText | HastElement | { type: string; children?: HastChild[] };
type HastParent = { children?: HastChild[] };

const MARKER = "{{secret";

export function rehypeSecretRefs(options: { tokenize: (text: string) => SecretTextTokenLike[] }) {
  const { tokenize } = options;
  return (tree: HastParent) => {
    walk(tree);
  };

  function walk(node: HastParent): void {
    if (!node.children) return;
    let changed = false;
    const next: HastChild[] = [];
    for (const child of node.children) {
      if (child.type === "text" && (child as HastText).value.includes(MARKER)) {
        const split = splitText(child as HastText);
        if (split) {
          next.push(...split);
          changed = true;
          continue;
        }
      } else if (child.type === "element") {
        const element = child as HastElement;
        if (element.tagName === "code") {
          const chip = wholeReference(element);
          if (chip) {
            next.push(chip);
            changed = true;
            continue;
          }
        } else if (element.tagName !== "pre" && element.tagName !== "a") {
          walk(element);
        }
      } else if ("children" in child) {
        walk(child as HastParent);
      }
      next.push(child);
    }
    if (changed) node.children = next;
  }

  function splitText(node: HastText): HastChild[] | null {
    const tokens = tokenize(node.value);
    if (!tokens.some((token) => token.type === "reference")) return null;
    return tokens.map((token) =>
      token.type === "reference"
        ? chipPlaceholder(token.reference.raw)
        : ({ type: "text", value: token.type === "text" ? token.value : token.raw } as HastText),
    );
  }

  function wholeReference(code: HastElement): HastElement | null {
    if (code.children.length !== 1) return null;
    const only = code.children[0]!;
    if (only.type !== "text") return null;
    const value = (only as HastText).value;
    if (!value.includes(MARKER)) return null;
    const tokens = tokenize(value.trim());
    const token = tokens.length === 1 ? tokens[0]! : null;
    return token?.type === "reference" ? chipPlaceholder(token.reference.raw) : null;
  }
}

function chipPlaceholder(raw: string): HastElement {
  return {
    type: "element",
    tagName: "span",
    properties: { dataOgSecretRef: raw },
    children: [{ type: "text", value: raw }],
  };
}
