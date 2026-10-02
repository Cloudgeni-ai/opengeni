-- deployment-mode: maintenance
-- Release marker for the forward-only, all-organization session-tenancy
-- activation performed by the matching production migration Job. This
-- migration is inert on its own: the Job must preflight and activate every
-- existing organization atomically while all application writers are parked.
-- A missing receipt fails the Job; no SQL-only shortcut may invent one.
SELECT 1;