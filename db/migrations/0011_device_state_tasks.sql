CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_type text NOT NULL DEFAULT 'conversation',
  user_message text,
  agent_reply text,
  status text NOT NULL,
  source_external_id text,
  channel jsonb NOT NULL DEFAULT '{}'::jsonb,
  conversation jsonb NOT NULL DEFAULT '{}'::jsonb,
  creator jsonb,
  assignee jsonb,
  error text,
  created_source_at timestamptz,
  updated_source_at timestamptz,
  sync_hash text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_device_id ON tasks(device_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_source_at ON tasks(updated_source_at);
CREATE INDEX IF NOT EXISTS idx_tasks_sync_hash ON tasks(sync_hash);
