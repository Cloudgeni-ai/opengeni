---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
---

sandbox_file_publish now publishes files of any size object storage accepts in one upload (up to 5 GB), not only files under 25 MiB. Files up to 25 MiB are still read through the API. A larger file is hashed where it lives and uploaded by the sandbox or Connected Machine straight to a signed storage URL, so its bytes never pass through the API. The signed URL stays in a private file outside the workspace, and the file is checked against its digest before and after the upload, so a file that changes mid-upload is reported, not published. The resulting workspace File ID works for browser uploads like any other, so an agent can upload, for example, a 190 MB app bundle through a web form.
