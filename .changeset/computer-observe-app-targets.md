---
"@opengeni/runtime": patch
---

computer_observe on an app target now returns its accessibility tree when the app has no screenshot, instead of failing the whole observation. Apps span several windows, so macOS and Linux adapters cannot photograph them; window and screen observations still fail clearly when their screenshot cannot be captured.
