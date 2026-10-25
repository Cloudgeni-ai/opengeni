---
"@opengeni/react": patch
---

Hosts that compile the components through the Tailwind v4 source bridge now render them the same as `compiled.css`. The scoped base (a root's own font and colour, scrollbars, selection colour, input cursors and the shimmer's display) moved into cascade layers, so a call-site utility on the same element wins again: the composer's "Connect a model" pill, for example, showed as a filled pill with no visible text. The README's bridge snippet now also imports `@opengeni/react/app.css`, which the session app needs. In `compiled.css` a root's base font and colour now have one class of specificity, like the rest of the scoped base, so a host's element selectors such as `button { font-family }` no longer restyle an Opengeni root.

