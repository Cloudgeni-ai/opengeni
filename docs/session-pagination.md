# Filtered session pages

The public page endpoint retains the existing subject and tenancy authorization. Each ordinary keyset page selects its filtered rows, complete row contents, and continuation boundary in one PostgreSQL statement. READ COMMITTED remains intentional for membership-removal fencing; a later hydration statement must not replace those rows with content from another snapshot. Legacy unfiltered snapshot cursors retain their existing authorization checks.

The workspace activity revision excludes rows changed after a continuation snapshot. Channel reassignment and foreign-key detachment therefore participate in the same activity commit gate, including a session attached concurrently after a folder deletion's preliminary scan. Row recency is preserved when only filing changes.

Creator filters use the equality prefix `(workspace_id, created_by_kind, created_by_subject_id)` followed by descending `(updated_at, id)`. This keeps sparse creator pages from scanning every more recent session in a workspace.

The API's `updatedFrom`, `updatedBefore`, `createdFrom`, and `createdBefore` filters accept ISO-8601 offsets with at most millisecond precision. More precise fractions receive HTTP400 instead of silently losing precision through JavaScript Date. Internal keyset timestamps continue to retain PostgreSQL microseconds.

## Deployment

Migration0413 is maintenance-only. Stop every old API, control worker, and turn worker and supply the exact runtime database role list before applying it. It expands the activity trigger to include `channel_id` and adds the creator index. Start only the binary whose `deleteChannel` opens the activity gate; old deletion code must not be restarted afterward. The migration checks for active configured roles before and after its table lock. No session history or authority is rewritten.
