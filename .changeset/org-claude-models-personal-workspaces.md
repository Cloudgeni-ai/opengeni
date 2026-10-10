---
"@opengeni/db": patch
---

An organization Claude subscription that is allowed in personal workspaces now offers its models there. Its model rows used the organization API-key scope, which hides everything from personal workspaces, so the model picker showed no Claude models and admission could not resolve one. Claude subscription model rows are now readable from any workspace of the organization; the subscription's own workspace and personal-workspace access still decides where it can be used, and API-key provider models keep the existing rule.
