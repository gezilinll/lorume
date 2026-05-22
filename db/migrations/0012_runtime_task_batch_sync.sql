DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'collector_ingestions'
      AND column_name = 'observed_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'collector_ingestions'
      AND column_name = 'collected_at'
  ) THEN
    ALTER TABLE collector_ingestions RENAME COLUMN observed_at TO collected_at;
  END IF;
END $$;

ALTER TABLE collector_ingestions ADD COLUMN IF NOT EXISTS collected_at timestamptz;
ALTER TABLE collector_ingestions DROP COLUMN IF EXISTS observed_at;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_message text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_reply text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sync_hash text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tasks'
      AND column_name = 'description'
  ) THEN
    EXECUTE 'UPDATE tasks SET user_message = COALESCE(user_message, NULLIF(description, '''')) WHERE user_message IS NULL';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tasks'
      AND column_name = 'title'
  ) THEN
    EXECUTE 'UPDATE tasks SET user_message = COALESCE(user_message, NULLIF(title, '''')) WHERE user_message IS NULL';
  END IF;
END $$;

ALTER TABLE tasks DROP COLUMN IF EXISTS title;
ALTER TABLE tasks DROP COLUMN IF EXISTS description;
ALTER TABLE tasks DROP COLUMN IF EXISTS last_seen_at;

CREATE INDEX IF NOT EXISTS idx_tasks_sync_hash ON tasks(sync_hash);
