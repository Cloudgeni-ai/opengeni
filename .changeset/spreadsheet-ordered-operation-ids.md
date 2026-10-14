---
"@opengeni/db": patch
---

Spreadsheet edits that send several commands in one batch now commit. The database checked the batch's operation ids as if they had to be alphabetically sorted, but they follow command order, so most multi-command edits failed with a generic commit error.

The migration grants the new id-list check to the configured application database roles (`OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES`, plus `opengeni_app` when present), so deployments with a custom runtime login keep writing editable artifacts before roles are next provisioned.
