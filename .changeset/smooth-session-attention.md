---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Make session attention monotonic across rapid navigation and nested trees. Failed sessions now remain red only until the viewer or their parent agent acknowledges the latest event, while historical failure lifecycle state remains intact.
