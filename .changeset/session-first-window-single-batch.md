---
"@opengeni/react": patch
---

Opening a long session shows its newest conversation sooner. The first history read now asks for 255 events, the most the server answers in a single database query, instead of 1,000, which it read in four sequential batches walking back through the conversation. On a long session whose rows were no longer cached that first read took 35 seconds before anything rendered. Scrolling back and catching up still load up to 1,000 events per page.
