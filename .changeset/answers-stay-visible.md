---
"@opengeni/react": patch
---

Keep every answer visible in the compact progress presentation (`turnSummary={{ rolling: true }}`). An answer was folded into the "Worked for …" row, and shown only as a muted two-line preview, as soon as another machine-triggered turn followed it in the same exchange (an agent message, child result, wait timeout, goal continuation, background command result, or steer instruction). Now only work folds: the later turns fold into a new row below the answer, which opens as soon as the input is delivered, and their own answers render below that row. A reader stopped at an answer stays in place while that later work runs.
