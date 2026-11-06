---
"@opengeni/core": patch
---

Externally metered models priced only by a reviewed list rate (newer Codex catalog models such as GPT-6.1 Sol and GPT-6.1 Terra, SuperGrok and Claude subscription models) now record their equivalent credit cost on model usage. Previously the equivalent cost came only from debit prices, so these calls carried a list-price provider estimate but no equivalent cost, and usage and cost views showed 0 for them. The list rate still never becomes debit authority.
