---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Stop presenting old attachments as if they came with the latest message after context compaction. Compaction used to add the files of summarized messages as an undated user message right after the latest request, so an agent could read a days-old image as something the person had just sent. New catalogs are a platform record placed before the retained messages, state that they are not user input, and list each file's upload time, frozen when the catalog is created. Catalogs created before this change replay exactly as before, so text already sent to a model is unchanged.
