---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Using a shared secret no longer implies seeing it. In workspace, task and organization vaults, only the person who saved an item and admins can reveal, copy or download its values or see its one-time codes; everyone else who may use it, including on existing items and items from connected password managers, uses it by reference and can still replace it. Only me secrets work as before. A new **Use only** setting makes a secret unrevealable for everyone, its creator and admins included; it can't be undone. Vault items gain `useOnly` and `canReveal`, and item create and update accept `useOnly: true`.
