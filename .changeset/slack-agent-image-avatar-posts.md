---
"@opengeni/api-router": patch
---

Agents with an image icon post in Slack again. Slack refuses a post whose picture URL is 256 characters or longer, which an image avatar's signed URL could reach on a longer host. New avatar URLs carry a 128-bit signature (older full-length URLs keep working), a picture URL that is still too long is left off, and a post Slack refuses with `invalid_arguments` while carrying a name or picture is sent once more as the app's.
