import { SURFACE_TINT_ALPHA, type ChatStyle } from "./style-knobs";

/**
 * The few lines that put the playground's chat in a product: the component,
 * and the theme and brand color on the element around it. The client points
 * at the product's own server route, which holds the API key (see
 * docs/product-integration.md); "Add it to your product" walks through that.
 */
export function chatSnippet(style: ChatStyle): string[] {
  return [
    'import { OpenGeniChat, OpenGeniProvider } from "@opengeni/react";',
    'import "@opengeni/react/compiled.css";',
    "",
    "<OpenGeniProvider client={client} workspaceId={workspaceId}>",
    style.theme === "light" ? '  <div data-og-theme="light" style={{' : "  <div style={{",
    `    "--og-color-accent": "${style.accent.value}",`,
    `    "--og-color-primary": "${style.accent.value}",`,
    `    "--og-color-surface-2": "${style.accent.value}${SURFACE_TINT_ALPHA}",`,
    "  }}>",
    "    <OpenGeniChat />",
    "  </div>",
    "</OpenGeniProvider>",
  ];
}

/** The lines a change added or edited: what the snippet marks. */
export function changedLines(previous: readonly string[], next: readonly string[]): number[] {
  const seen = new Set(previous);
  return next.flatMap((line, index) => (seen.has(line) ? [] : [index]));
}
