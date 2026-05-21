ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'conversation';

UPDATE tasks
SET task_type = CASE
  WHEN raw->>'taskType' = 'scheduled' THEN 'scheduled'
  ELSE 'conversation'
END;

CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(task_type);
