---
"@opengeni/storage": patch
---

`createGetUrl` accepts an optional `responseContentDisposition` that signs a `Content-Disposition` response override into the URL (S3-compatible, AWS S3, Azure Blob and GCS), so a browser that opens it downloads the object instead of rendering it.
