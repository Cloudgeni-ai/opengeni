# `@opengeni/ui`

Framework-neutral semantic UI contracts and CSS for OpenGeni session embeds.

```ts
import { sessionStatusPresentation } from "@opengeni/ui";
import "@opengeni/ui/compiled.css";
```

Render shared surfaces beneath `.og-root`, expose `data-og-component`, `data-og-part`, and closed state attributes, and override `--og-*` custom properties on any ancestor. The package has no React, Svelte, SDK, or server runtime dependency.

Use `bridgeOpenGeniPortalTokens(source, portalRoot, { publishSourceInlineSize: true })` when a dialog or menu leaves the themed subtree. Call `destroy()` when that portal closes.

## What the package owns

- closed anatomy and part names used by both framework packages;
- shared copy and semantic status presentation;
- exhaustive icon roles without framework component types;
- theme, density, motion, responsive, portal, and safe-area contracts;
- deterministic CSS scoped to `.og-root` with no global reset or framework
  source scan.

The package also owns the canonical source bytes for the established React
`tokens.css` and `responsive.css` compatibility subpaths. The React package
generates exact local copies before compiling its advanced React-only utility
surface, and parity tests fail if those public copies diverge.

Import `compiled.css` for the complete shared layer, or compose the focused
entries:

```ts
import "@opengeni/ui/tokens.css";
import "@opengeni/ui/components.css";
import "@opengeni/ui/responsive.css";
```

Components should express state through the typed `data-og-*` contract and
semantic roles rather than framework-specific class names. React and Svelte
map icon roles to their own native icon components and retain their own focus,
measurement, and portal primitives. See
[`docs/framework-ui.md`](../../docs/framework-ui.md).