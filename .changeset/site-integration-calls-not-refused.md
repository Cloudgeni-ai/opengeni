---
"@opengeni/api-router": patch
---

Apps (Sites) can call API integrations such as OneDrive and SharePoint again. The last check before a targeted tool call compared the connection's last-used time, which the call itself had just updated, so every such call was refused and shown as "Couldn't confirm this finished".
