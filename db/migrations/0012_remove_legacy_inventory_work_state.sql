DROP TABLE IF EXISTS work_executions;
DROP TABLE IF EXISTS work_items;
DROP TABLE IF EXISTS work_conversations;
DROP TABLE IF EXISTS channel_bindings;

ALTER TABLE runtimes
  DROP COLUMN IF EXISTS endpoint,
  DROP COLUMN IF EXISTS capabilities,
  DROP COLUMN IF EXISTS source_refs;

ALTER TABLE agents
  DROP COLUMN IF EXISTS origin,
  DROP COLUMN IF EXISTS load,
  DROP COLUMN IF EXISTS source_refs;
