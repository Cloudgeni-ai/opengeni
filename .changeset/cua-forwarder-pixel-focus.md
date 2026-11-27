---
"@opengeni/browserd": patch
---

Typing into a field of an iOS Simulator device (or another app that shows a device's screen, such as Screen Sharing, iPhone Mirroring or UTM) after clicking it now reaches that field. The device's fields are not in the app's accessibility tree, so the CUA driver's focus step at the clicked point either failed ("focus pixel-click ... failed", nothing typed) or left the focus where it was, and the text went into the field focused before. The pinned driver now clicks the point in such an app, which moves the device's focus.
