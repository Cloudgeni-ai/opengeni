-- deployment-mode: rolling
-- A composer draft either holds the model the person picked in the composer
-- or follows the chat's own settings. While it follows, reads return the
-- chat's current model, reasoning effort and speed, so a change made outside
-- the composer (for example the agent switching the chat's model) is what
-- the person's next Send uses instead of being undone by it.
--
-- Every existing draft follows: the stored settings of an existing draft are
-- whatever the chat used when it was last saved, and a draft only keeps its
-- own choice once a newer client saves one. The constant default makes this
-- a catalog-only change. A previous binary neither names nor reads the
-- column: it keeps reading and writing the stored settings as before, and its
-- inserts take the default.
SET LOCAL lock_timeout = '5s';

ALTER TABLE composer_drafts ADD COLUMN policy_follows_session boolean NOT NULL DEFAULT true;
