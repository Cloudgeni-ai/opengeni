---
"@opengeni/react": patch
---

Inline chat previews (`opengeni-html`) now keep the "Preparing preview…" surface over the frame until its content can paint, instead of showing an empty white box while render-blocking stylesheets (such as Google Fonts) or the HTML frame host load. The preview reports its height before the visualization helpers' CDN scripts, so a slow CDN no longer holds it at its initial height.
