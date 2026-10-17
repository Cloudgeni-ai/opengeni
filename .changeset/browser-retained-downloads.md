---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
---

Completed browser downloads stay saveable after the browser is suspended. Suspension removes the browser's working directory, so before an explicit suspend or an automatic idle or deadline save, each completed download is now kept as a workspace file. Listing, reading and saving a download then work while the browser is suspended, after it resumes on a new controller, and after the task moves to another machine, which imports the file from storage. A download that cannot be kept is logged and never blocks the suspension.
