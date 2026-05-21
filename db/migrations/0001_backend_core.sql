CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY,
  hostname text NOT NULL,
  os text NOT NULL,
  architecture text,
  collector jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  observed_at timestamptz NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtimes (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  version text,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtimes_device_id ON runtimes(device_id);
CREATE INDEX IF NOT EXISTS idx_runtimes_kind ON runtimes(kind);
CREATE INDEX IF NOT EXISTS idx_runtimes_status ON runtimes(status);
CREATE INDEX IF NOT EXISTS idx_runtimes_last_seen_at ON runtimes(last_seen_at);

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  runtime_id text NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL,
  last_seen_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_runtime_id ON agents(runtime_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_last_seen_at ON agents(last_seen_at);

CREATE TABLE IF NOT EXISTS collector_ingestions (
  id bigserial PRIMARY KEY,
  device_id text NOT NULL,
  snapshot_type text NOT NULL,
  status text NOT NULL,
  observed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collector_ingestions_device_id ON collector_ingestions(device_id);
CREATE INDEX IF NOT EXISTS idx_collector_ingestions_snapshot_type ON collector_ingestions(snapshot_type);
CREATE INDEX IF NOT EXISTS idx_collector_ingestions_received_at ON collector_ingestions(received_at);
