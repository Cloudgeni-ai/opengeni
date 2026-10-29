---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

An image whose declared type does not match its bytes, such as a JPEG screenshot that a chat app or MCP tool labels `image/png`, no longer fails the turn on Claude models. The model image sizer used to require the declared type to match the bytes and threw otherwise, and because the image stays in the chat's history, every later turn failed the same way until someone edited the stored label. The sizer now identifies PNG, JPEG, WebP and GIF from the bytes and labels the image with its real format; anything else (SVG, HEIC, damaged data) is still refused before any decoder runs. On the Claude transport, a mislabeled image that needs no resizing is sent with its real type and no resize note. Stored attachments under the wrong type keep exactly the projection they always had, so earlier requests stay byte-identical.
