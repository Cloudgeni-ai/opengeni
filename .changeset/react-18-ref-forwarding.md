---
"@opengeni/react": patch
---

The components now work on React 18, which the package has always declared alongside 19. Many of them read `ref` as an ordinary prop, which only React 19 passes through, so on React 18 (and runtimes that behave like it, such as Preact with `preact/compat`) a ref never reached its element. In a narrow embed, where `SessionShell` shows the chat list as a drawer, focus did not return to "Open navigation" after the drawer closed, Radix triggers built with `asChild` lost their anchor, and on some runtimes opening and closing the drawer threw and left the page covered by overlays. Every component that takes a ref now forwards it with `forwardRef`, which works the same on React 18 and 19, and `inert` is written in a form both versions apply. `NewSessionLink` accepts anchor props and a ref, so a tooltip trigger can wrap it. A host that supplies its own `NavigationHost.Link` on React 18 should wrap that link in `forwardRef` so the ref reaches its anchor.
