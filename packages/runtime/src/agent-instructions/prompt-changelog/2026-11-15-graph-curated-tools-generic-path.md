# Reviewed Microsoft 365 tool sets, generic find-and-call tools, pinned Graph document

No system-prompt text changes. Tool lists, tool names, tool descriptions and
tool-result texts change for the Microsoft Graph built-ins.

Outlook Mail, Outlook Calendar, Outlook Contacts and OneDrive offer a reviewed
operation set (25, 20, 13 and 19 tools, from 150, 177, 76 and 452) with
hand-written names and descriptions. Each description says what the operation
does and, for writes, the JSON body shape it takes; none names a task, a
person or an example workspace. Tool ids are unchanged for the operations that
remain. Two new OneDrive tools have reviewed ids (`drives_getitembypath`,
`drives_uploadfile`). Generated text still appends the method, path and
approval sentence to each description, as before. The per-tool texts are
listed in the pull request.

Those four definitions also get three generic tools for operations outside the
reviewed set (descriptions verbatim):

```text
+ Find API operations: Find operations of this API that the other tools of this integration don't cover. Searches the reviewed API description by words in the path or summary and returns each match's method, path template and summary, the scopes it needs when the API declares them, and the dedicated tool when one exists. Call a match with this integration's call tools: the read one for GET, the change one for other methods. Read-only.
+ Call API read operation: Call a GET operation of this API that no other tool of this integration covers, using its concrete path. Find the operation first with this integration's find tool. Read-only.
+ Call API change operation: Call a POST, PUT, PATCH or DELETE operation of this API that no other tool of this integration covers, using its concrete path. Find the operation first with this integration's find tool. Changes external state. Your tool permissions determine whether review is needed.
```

Their parameter descriptions:

```text
+ query: Words to look for in the operation's path and summary.
+ path: The concrete path under the API's base URL: the operation's path template with each {placeholder} replaced by its value, without a query string.
+ query: Query parameters, for example $select, $filter, $top or $search. Values are strings, numbers, booleans or arrays of them.
+ header: Extra request headers the operation documents, for example Prefer.
+ body: The request body: JSON for JSON operations, or text with contentType for others.
+ contentType: The body's media type when it isn't JSON, for example text/plain.
```

A path parameter that only a reviewed request path names takes its reviewed
description (today the two OneDrive tools above):

```text
+ The item's path from the top of the drive, for example Documents/Plan.docx, as plain text.
+ The new file's name, or its path below the folder, for example notes.txt, as plain text.
```

New tool-result errors (`parameter_invalid`, nothing is sent):

```text
+ query needs at least one word to look for
+ path must start with / and name an operation's concrete path
+ Put query parameters in query, not in path
+ path cannot contain empty segments
+ A path segment cannot be . or ..
+ The path is not valid Unicode text
+ No <METHOD> operation in this integration's scope matches that path. Find the operation and its path template with this integration's find tool.
+ header must be an object
+ The header <name> can't be set here
+ Header values must be strings
+ method must be post, put, patch or delete
+ query must be an object
```

Connect answers a pinned document whose digest differs with:

```text
+ <integration name>'s reviewed API description did not match its pinned digest
```

Why this is general: the descriptions describe the provider's operations, the
generic tools are opt-in for any reviewed OpenAPI definition and name no
provider, and the errors describe the request. Size: the four definitions'
tool lists shrink from 855 to 89 tools.
