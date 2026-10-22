---
"@opengeni/browserd": minor
"@opengeni/runtime": patch
"@opengeni/codemode": patch
"@opengeni/browser-extension": minor
---

Downloads now work in attached Chrome. A file that a tab Opengeni controls downloads appears in `browser_downloads` like a managed browser's download, and `browser_download_save` saves it into the session's workspace. Chrome still saves it in the person's own downloads folder, where it stays untouched; the session keeps a verified copy. The extension asks for Chrome's `downloads` permission so it can tell where Chrome saved a controlled tab's download (it looks up only completed downloads of that address since the download began). With an older extension, such a download is listed as failed with `download_location_unavailable`.
