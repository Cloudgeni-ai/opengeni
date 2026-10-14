---
"@opengeni/contracts": minor
"@opengeni/runtime": minor
"@opengeni/db": patch
---

Agents using a personal Slack connection can now read files people share in Slack. A new `slack_download_file` tool fetches one file by its ID and saves it into the agent's workspace like an attachment, so PDFs, images and documents can be opened with the agent's usual tools. The Slack connection now asks for `files:read`; the tool appears only for connections that granted it, so existing connections are unchanged until they reconnect. The user token is sent only to Slack's private file host, Slack's sign-in page is reported as missing access rather than saved, and file bytes and private URLs never appear in tool results.
