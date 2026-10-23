---
---

Agent only: a machine whose browser is attached through the Chrome extension can update itself again. Background debugger event polls no longer count as work that keeps a self-update waiting, and an update's idle check no longer refuses them, which broke every attached event stream and detached its tabs each time the check ran.
