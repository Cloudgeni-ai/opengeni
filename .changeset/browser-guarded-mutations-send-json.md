---
"@opengeni/sdk": patch
---

People signed in to the web app can again start a Codex sign-in from a workspace's Models page, disconnect a connected agent, and revoke a personal API key. These requests carried no JSON body, so the browser guard on their routes refused them with "You don't have permission". A contract test now fails when any client call to a browser-guarded route omits the JSON body.
