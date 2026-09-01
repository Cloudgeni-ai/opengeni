---
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Surface sandbox admission failures across Browser, Desktop, and Files instead of leaving prepared operations or live workbench surfaces stuck in starting states. Files warm-allowance denials now replace the waking state immediately while preserving Desktop's viewer-cap signal and ordinary retry/cancellation behavior.

Legacy BrowserSession capability documents now default omitted permissions support to false.
