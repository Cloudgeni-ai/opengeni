-- deployment-mode: rolling
-- A private file belongs to exactly one person. Every writer stores either
-- NULL (shared with the workspace) or ARRAY[owner], and the visibility trigger
-- only moves a file between those two shapes. File lists read a person's own
-- files from indexes keyed on the array's first element (1410-1412). That
-- matches the row-level security test `owner = ANY(private_owner_subject_ids)`
-- only while the array has one element, so the schema now says so.
--
-- Rolling: a check added NOT VALID in a short transaction; 1408 validates it.
-- The previous release writes only the two allowed shapes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE files
  ADD CONSTRAINT files_private_owner_single_chk
  CHECK (private_owner_subject_ids IS NULL OR cardinality(private_owner_subject_ids) = 1)
  NOT VALID;
