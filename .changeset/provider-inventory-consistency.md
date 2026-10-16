---
"@opengeni/vaults": minor
"@opengeni/core": patch
---

Provider listings now say whether they prove which items are absent. `traverseProviderPages`, `readProviderVaultInventory` and `readProviderItemInventory` return `{ items, consistent }`, where consistent means one response or every page under one snapshot. `collectProviderPages`, `listProviderVaults` and `listProviderItems` keep their bounded enumeration for discovery.

A connected vault's mirror is replaced only from a consistent inventory. A multi-page listing without a snapshot keeps the previous mirror and records `provider_inventory_incomplete`, because offset cursors can skip an existing item when an earlier one is deleted between pages; a vault missing from such a vault listing is not reported as removed. An item with more than 50 fields or 20 websites, or a website over 2,048 characters, also makes the inventory incomplete instead of being cut down, and the previous mirror is kept.
