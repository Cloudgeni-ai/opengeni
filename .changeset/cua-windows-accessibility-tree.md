---
"@opengeni/browserd": patch
---

Computer use on Windows now returns the window's accessibility tree. The Windows adapter did not ask CUA for structured elements, which CUA only returns on request, and CUA's one-second default walk budget timed out before Windows UI Automation answered even simple windows such as Notepad or the Run dialog. Observations therefore always said "no readable elements". The adapter now requests elements on every platform and gives Windows a five-second walk budget.
