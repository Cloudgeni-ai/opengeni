---
"@opengeni/capabilities": patch
"@opengeni/api-router": patch
---

Apply the curated source size limit consistently when parsing Microsoft's Graph definition while preserving the smaller limit for custom sources. Keep OneDrive file and sharing operations within the tool limit by excluding the nested Excel workbook API.
