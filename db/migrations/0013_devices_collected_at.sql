DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'devices'
      AND column_name = 'observed_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'devices'
      AND column_name = 'collected_at'
  ) THEN
    ALTER TABLE devices RENAME COLUMN observed_at TO collected_at;
  END IF;
END $$;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS collected_at timestamptz;

UPDATE devices
SET collected_at = COALESCE(collected_at, last_seen_at, updated_at, created_at, now())
WHERE collected_at IS NULL;

ALTER TABLE devices ALTER COLUMN collected_at SET NOT NULL;
ALTER TABLE devices DROP COLUMN IF EXISTS observed_at;
