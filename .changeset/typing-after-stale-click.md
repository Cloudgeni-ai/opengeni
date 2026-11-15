---
"@opengeni/browserd": patch
---

On macOS, typing into a window whose fields are not in its accessibility tree (a Simulator device, an Android emulator) goes to the point of the click just before it. That click now counts only for two minutes. Before, a click from hours earlier still counted when no other action had been sent to the window since, so typing after the field was focused by other means (the person, the device's own tools) clicked again at the old point, which could press whatever is there now. Such typing is now refused before anything is sent, with the existing message to click the field and then type.
