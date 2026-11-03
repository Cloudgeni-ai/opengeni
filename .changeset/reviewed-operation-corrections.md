---
"@opengeni/capabilities": patch
---

Reviewed OpenAPI definitions can now correct a provider's document declaratively, without new prompt text.

- `requestPath` sends a reviewed operation to a different path while it keeps its tool identity. `{+name}` in it expands a path parameter as a path (RFC 6570 reserved expansion, marked as `allowReserved` on the binding): each segment is encoded, `/` is kept, extra slashes are dropped, and a `.` or `..` segment is refused as a recoverable error.
- `omitQueryParameters` drops query parameters the provider documents but rejects.
- `operationText` replaces a prefix-selected operation's summary and description when the provider's text describes a different operation.

These Microsoft definitions use the new fields:

- SharePoint's site lookup by path now uses Graph's colon form, `/sites/{hostname}:/{path}`, which Graph accepts. Previously it sent an encoded `getByPath(path='%2Fsites%2Fhr')`, which Graph rejected with "Error in query syntax".
- Teams channel messages no longer offer `$orderby`, which Graph rejects.
- Outlook's list, create-draft and get message operations get correct names and descriptions instead of Graph's open-extension and eventMessage text.
- The SharePoint and Teams search descriptions now say to send one entry in `requests` per call, because Graph v1.0 rejects several.

Installed integrations adopt these changes when their definition is refreshed.
