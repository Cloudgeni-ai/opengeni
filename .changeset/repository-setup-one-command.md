---
"@opengeni/runtime": patch
---

Repository setup on a fresh sandbox now takes one command. The clone program travels compressed inside the launcher, which installs it under its content hash and runs it in the same command; programs unique to one turn (Smart-Git broker routes) decode, run and remove themselves in one command too, and a successful run no longer pays a separate seed-cleanup round trip. Before, a fresh box probed for the program, then bootstrapped, uploaded 2 KiB chunks, decoded and launched again: seven sequential sandbox round trips. On a Modal box in the EU, cloning three small repositories on a new box went from about 2.8–3.3 s to about 2.0–2.2 s (six fewer round trips, about 0.9 s); the rest is the box finishing its boot and the clone itself. Boxes without gzip keep the staged path, and staged chunks are now 12 KiB instead of 2 KiB.
