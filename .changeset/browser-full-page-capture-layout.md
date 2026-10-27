---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/api-router": patch
"@opengeni/codemode": patch
---

A full-page browser screenshot no longer changes the page's layout. Chromium hides classic scrollbars for a capture beyond the viewport, so content used to widen by the scrollbar's width while it was captured, right-aligned elements moved, and the change stayed after the capture; the image was also narrower than the tab's viewport. The capture now keeps each scrollbar's space with a temporary inspector stylesheet that page scripts cannot see, re-evaluates scrollbars afterwards, and is as wide as the tab's viewport. Screenshot scale now comes from the emulated device scale factor instead of the image width, which excluded the scrollbar. When some scrollbars cannot be kept (horizontal ones, ones inside shadow trees), the browser_screenshot result and Code Mode screenshot metadata carry a short `note` saying so, and the SDK frame has `inexactScrollbars: true`.
