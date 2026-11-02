---
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Signed-out guests of a public Site can now open the Site's shared files. Before, every guest file request was refused, so a public Site that kept its images or video in Site files showed without them to signed-out visitors. Guests now list and open files with scope `shared` only: private files stay hidden (opening one returns not found), and uploading, deleting and the quota check stay refused for guests. Existing per-visitor and per-address limits still apply. Signed-in viewers still see shared files plus their own, and managers see every file. The Site runtime API docs, the Sites skill and the `site_files_upload` tool description now say the same.
