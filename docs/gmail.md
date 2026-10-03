# Gmail

OpenGeni's reviewed Gmail bridge calls the Gmail REST API through the native
connection broker. The historical `https://gmailmcp.googleapis.com/mcp/v1`
identity selects this bridge; Google's hosted MCP preview is not contacted.
Connections remain personal, scoped to the accepted initiating human and selected
account, with live authority checks for every physical provider request.

The existing OAuth bundle is unchanged: `gmail.readonly`, `gmail.compose` and
`gmail.modify`. No additional Google consent is needed for these tools:

| Area | Tools |
| --- | --- |
| Search/read | `search_threads`, `search_messages`, `get_thread`, `get_message`, `get_profile` |
| Original bytes | `download_attachment`, `download_message` |
| Drafts/send | `create_draft`, `list_drafts`, `get_draft`, `update_draft`, `delete_draft`, `send_message`, `send_draft` |
| Labels | `list_labels`, `get_label`, `create_label`, `update_label`, `delete_label` |
| Organization | `label_message`, `unlabel_message`, `label_thread`, `unlabel_thread`, `modify_message`, `modify_thread`, `batch_modify_messages` |
| Trash | `trash_message`, `restore_message`, `trash_thread`, `restore_thread` |
| Import | `import_message`, `insert_message` |
| Changes | `get_history`, `watch_mailbox`, `stop_watch` |
| Settings reads | `get_settings`, `list_settings` |

Message search returns matching individual emails; thread search returns matching
conversations, including messages within them that did not match the query.
Search/draft/history pages are bounded to 50 entries; follow the returned opaque
page token. Label listing defaults to user labels; `includeSystem: true` also
includes system labels. Label updates default to PATCH, preserving omitted fields.
The replacement form uses `replace: true` and requires a complete name.

Atomic label changes express archive (`removeLabelIds: ["INBOX"]`), read/unread
(`UNREAD`), star (`STARRED`), importance (`IMPORTANT`) and spam (`SPAM`). Trash uses
dedicated operations. User label deletion does not delete messages. Draft deletion
permanently removes that unsent draft; permanent deletion of messages/threads is
not exposed because it requires the broader full-mail scope.

## Files and composing

`get_message` preserves all root headers and MIME part metadata, including
`partId`, charset/disposition headers, attachment IDs and Content-ID. External
text body parts are retrieved and decoded in their declared charset. Body text
projections are bounded to 256 Ki characters each and explicitly report
`contentTruncated` and `decodingErrors`. Download the original message or a body
part when exact or omitted data is needed.

`download_attachment` resolves an exact leaf part in the selected message. Both
external Gmail attachments and inline bytes are supported, including empty files.
`download_message` returns a complete original RFC 5322 `.eml`. Downloads are
bounded to 50 MiB per file. Worker-owned temporary byte staging feeds the existing
transactional filesystem importer, verifies size/hash, then cleans up the transfer
object. The model receives only a file receipt; it never receives a credential,
signed source URL or attachment byte dump. No document processing is prescribed.
Idempotent cleanup retries are bounded; persistent failure is reported to the
operator without discarding a verified receipt or masking import uncertainty.
An unavailable filesystem returns an error, never a successful delivery receipt.

Composing supports To/Cc/Bcc, formatted recipient names, UTF-8 subject/body,
verified From aliases, Reply-To, threading and inline Content-ID attachments.
Cc-only/Bcc-only messages are valid. Attachment sources are base64 `content` or
a workspace `file: { path, sha256 }`; an exact hash protects approval against
later file changes. Files are read through workspace-confined filesystem access.
The combined attachment input is bounded to 25 MiB; encoded messages to 35 MiB.
`raw` (base64url) or `rawFile: { path, sha256 }` accepts a complete message as an
alternative to composing fields. It preserves any MIME structure the caller
supplies. Import/insert do not send mail; import defaults Calendar processing off.

`get_draft` reads one raw snapshot, derives its review content and returns
`contentSha256`. `send_draft` requires that hash, reads the current draft and
rejects stale content. Its final provider request includes the exact reviewed raw
bytes, preventing intervening edits from changing the approved send content.
`update_draft` replaces the complete saved content, retaining the draft ID; an
optional expected hash guards against replacing an independently edited draft.

Every mailbox mutation retains the catalog's mandatory human approval floor.
No mutation is retried automatically after submission or an uncertain response.
Read requests can refresh once after a provider 401; destination redirects are
rejected. Cancellation propagates to requests and filesystem authority checks.

## History, notifications and settings

Obtain an initial history cursor with `get_profile`. Consume every history page
before advancing a saved cursor. Expired cursors return `resyncRequired: true`;
perform a full search and take a fresh profile cursor. History IDs are opaque
decimal strings, never JavaScript numbers.

`watch_mailbox` uses only `OPENGENI_GMAIL_WATCH_TOPIC_NAME`, an operator-owned
`projects/.../topics/...` value. Agents cannot choose another destination.
Configure the topic in the OAuth application's Cloud project and grant
`gmail-api-push@system.gserviceaccount.com` publish access. The operator owns
notification ingress/dispatch; this tool does not silently create a schedule or
promise an automatic agent wakeup. Renew watches before expiration, deduplicate
notifications using history and retain polling reconciliation. `stop_watch`
stops the account's current watch, including any existing watch.

Settings reads include language, vacation, POP/IMAP, auto-forwarding, filters,
send-as aliases and forwarding addresses. Delegation reads require service-account
domain-wide authority and are excluded from the connected-user bridge. S/MIME and client-side
encryption metadata is also readable when the account is eligible; ordinary
personal Gmail may reject those resources. The bridge does not change settings,
forwarding, delegation, or encryption and does not decrypt protected content.

Runtime descriptors and scope classification live in `gmail-rest-tools.ts` and
`gmail-rest-mcp.ts`; the curated catalog pins the allowed tools and approval
floor. Existing explicit session/schedule selections remain ceilings. Update a
selection deliberately when its old allowed tool list excludes new tools; adding
implementation does not widen accepted historical authority.
