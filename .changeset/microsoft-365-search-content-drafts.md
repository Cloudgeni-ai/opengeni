---
"@opengeni/capabilities": patch
---

SharePoint can now read a document library file's content (`GET /drives/{drive-id}/items/{driveItem-id}/content`, read-only, the same reviewed operation OneDrive has), so a SharePoint-only connection no longer stops at a file's metadata. Like every safe read, its redirect to Microsoft's pre-authenticated download URL is followed without credentials.

A reviewed Microsoft Graph search body with several entries in `requests` now runs each entry as its own call and answers with their results in one `value` list. Graph v1.0 refuses such a body ("Multiple entity search is not supported in v1.0"), although one request may combine entity types. The SharePoint search description now says that one request may combine driveItem, listItem, list, site and drive (Graph accepts it), that list rows are listItem results, and its example searches files, list items, lists and sites together. The SharePoint list tool says it lists a site's lists and libraries.

The Outlook Mail create-draft tool's description now starts "Create a new email draft", so a search for an email draft ranks it above the reply and forward draft tools.
