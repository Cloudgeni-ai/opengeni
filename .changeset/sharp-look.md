---
"@opengeni/react": minor
---

Sharper default look: higher-contrast neutral tokens in light and dark (light text `#171717` / `#525252` / `#6b6b6b`, dark `#f5f5f5` / `#a6a6a6` / `#8c8c8c`), solid near-black dark surfaces, and a solid primary button (`#171717` in light, `#f2f2f2` in dark). Decorative gradients and glows are gone; `.og-rail-glow` and `.og-page-glow` now paint solid surfaces and the `--og-color-glow-*` tokens are kept only for compatibility. Row titles use weight 600, headings `-0.012em` tracking, and catalog lists sit on one bordered card.

New optional props: `RowList` `card`, `LogoTile` `hue` (a tinted icon tile), plus the `logoTileHue(seed)` helper.
