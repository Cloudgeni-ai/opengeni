---
"@opengeni/react-native": patch
---

The scroll-edge cover under a floating Liquid Glass composer now actually paints. It was an SVG gradient that drew nothing on device, so conversation text still showed through the glass and between the composer and the screen edge. It is now drawn with plain views: a short fade into the page color just above the composer, then a solid page-color block behind and below it.
