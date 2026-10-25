-- deployment-mode: rolling
-- Validate the item type and category checks the previous migration added
-- NOT VALID. Every existing row already has one of the earlier types and no
-- category.
SET LOCAL lock_timeout = '5s';

ALTER TABLE vault_items VALIDATE CONSTRAINT vault_items_category_check;
ALTER TABLE vault_items VALIDATE CONSTRAINT vault_items_type_check;
