# Microsoft 365 search, SharePoint file content and draft discoverability

No system-prompt text changes. Tool lists and tool descriptions change for the
SharePoint and Outlook Mail built-ins. Each text says what the operation does;
none names a task, a person, a test fixture or an example workspace.

SharePoint gains one reviewed read-only tool (summary "Download file"):

```text
+ Download a document library file's content by its drive id and item id.
```

Changed SharePoint descriptions:

```text
- Search SharePoint and OneDrive files, lists and sites the signed-in person can access. Send {"requests":[{"entityTypes":["driveItem"],"query":{"queryString":"..."},"from":0,"size":25}]}. Use entityTypes driveItem for files, listItem for list items, site for sites, list for lists and libraries. Send exactly one entry in requests per call; its entityTypes may combine driveItem, listItem and list, but search site in a call of its own. KQL is supported in queryString (for example filetype:docx or path:"https://contoso.sharepoint.com/sites/hr"). Page with from and size. Only driveItem, listItem, list, site and drive can be searched here.
+ Search SharePoint and OneDrive files, lists, list items and sites the signed-in person can access. Send {"requests":[{"entityTypes":["driveItem","listItem","list","site"],"query":{"queryString":"..."},"from":0,"size":25}]}. Use entityTypes driveItem for files, listItem for list items, list for lists and libraries, site for sites and drive for document libraries; one request may combine any of them, which finds content whatever its kind. List rows are listItem results, not driveItem. KQL is supported in queryString (for example filetype:docx or path:"https://contoso.sharepoint.com/sites/hr"). Page with from and size. Only driveItem, listItem, list, site and drive can be searched here.
- Read a file or folder in a document library. A file's response includes @microsoft.graph.downloadUrl, a short-lived pre-authenticated link: download the file bytes from it directly, without credentials.
+ Read a file or folder in a document library: its name, size, dates and web link. Read a file's content with the download file tool.
+ List a site's lists and document libraries with their ids and names. Read a list's rows with the list items tool.
```

(The list tool had no reviewed description before; it used Graph's summary.)

Why these are general: Graph v1.0 accepts every combination of driveItem,
listItem, list, site and drive in one request (checked against Graph on
16 November 2026), so the old "search site in a call of its own" was wrong,
and a driveItem-only example led models to miss list content, which Graph only
returns as listItem or list. A library file's content was unreachable from
SharePoint, so the item description pointed at a URL no tool could fetch.

Outlook Mail create-draft description:

```text
- Create a draft in the signed-in person's Drafts folder without sending it. Send it later with the send draft tool.
+ Create a new email draft in the signed-in person's Drafts folder without sending it. Send it later with the send draft tool.
```

Why: with only "draft" in common, a query for an email draft ranked the
forward and reply draft tools as high as the new-message one. Naming what it
drafts ranks it first for new-email drafts without moving reply or forward
queries. Size delta: about +70 bytes of tool text in total, outside the system
prompt.

New tool behavior, no new text: a reviewed Graph search body with several
entries in `requests` runs each entry as its own call and returns their
results as one `value` list, instead of Graph's refusal.
