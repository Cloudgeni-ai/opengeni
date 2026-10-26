---
"@opengeni/react": patch
---

Capability logos now look the same on every surface. `LogoTile`, `CapabilityLogo` and `ConnectionLogo` measure each logo once after it loads (new `logo-fit` helper, cached by URL): a roughly square image with opaque edges is an app icon and fills the tile, anything else is a mark and sits padded on a light plate in both themes, so dark marks no longer disappear on dark backgrounds. An image the browser cannot read (a cross-origin asset without CORS) is treated as a mark. `LogoTile`'s `fit` now defaults to `"auto"`; `"cover"` and `"contain"` still force a treatment. `CapabilityLogo` is now drawn by `LogoTile` (same sizes as before). `ConnectionLogo` exposes the decision as `data-fit` and, like `LogoTile`, shows a missing logo as a monogram on surface-2 in both themes; the `--og-connection-icon-padding` variable is gone and dark marks use `--og-connection-mark-plate` (default `--og-color-fg`).
