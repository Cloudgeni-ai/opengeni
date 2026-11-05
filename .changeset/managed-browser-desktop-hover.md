---
"@opengeni/browserd": patch
---

A managed browser without a window (headless, or offscreen on macOS) now presents a desktop mouse to pages: `(hover: hover)` and `(pointer: fine)` match, as in any desktop Chrome, so hover styles such as Tailwind's `hover:` variants apply and can be checked. Before, headless Chrome saw no input device and matched `(hover: none)` and `(pointer: none)`. A mobile viewport still presents a touch screen, and a desktop viewport or a reset no longer turns touch emulation off when it was never on, which used to drop the page back to no pointer at all.
