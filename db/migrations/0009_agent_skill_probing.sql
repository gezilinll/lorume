CREATE TABLE IF NOT EXISTS agent_skill_probe_snapshots (
  id text PRIMARY KEY,
  device_id text NOT NULL,
  runtime_id text NOT NULL,
  agent_id text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'unknown',
    'succeeded',
    'unsupported',
    'failed'
  )),
  observed_at timestamptz,
  probed_at timestamptz,
  error_summary text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_skill_probe_snapshots_agent_id
  ON agent_skill_probe_snapshots(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_skill_probe_snapshots_device_id
  ON agent_skill_probe_snapshots(device_id);
CREATE INDEX IF NOT EXISTS idx_agent_skill_probe_snapshots_status
  ON agent_skill_probe_snapshots(status);
