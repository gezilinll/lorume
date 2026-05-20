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
  endpoint text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  origin text NOT NULL,
  status text NOT NULL,
  load jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_runtime_id ON agents(runtime_id);
CREATE INDEX IF NOT EXISTS idx_agents_origin ON agents(origin);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_last_seen_at ON agents(last_seen_at);

CREATE TABLE IF NOT EXISTS channel_bindings (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL,
  label text NOT NULL,
  external_id text,
  status text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channel_bindings_agent_id ON channel_bindings(agent_id);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_kind ON channel_bindings(kind);

CREATE TABLE IF NOT EXISTS work_conversations (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  runtime_id text REFERENCES runtimes(id) ON DELETE SET NULL,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  source text NOT NULL,
  external_id text NOT NULL,
  status text NOT NULL,
  channel_kind text,
  channel_label text,
  title text,
  work_item_id text,
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz,
  last_activity_at timestamptz,
  last_seen_at timestamptz,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_conversations_device_id ON work_conversations(device_id);
CREATE INDEX IF NOT EXISTS idx_work_conversations_runtime_id ON work_conversations(runtime_id);
CREATE INDEX IF NOT EXISTS idx_work_conversations_agent_id ON work_conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_work_conversations_source ON work_conversations(source);
CREATE INDEX IF NOT EXISTS idx_work_conversations_status ON work_conversations(status);
CREATE INDEX IF NOT EXISTS idx_work_conversations_last_seen_at ON work_conversations(last_seen_at);

CREATE TABLE IF NOT EXISTS work_items (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  runtime_id text REFERENCES runtimes(id) ON DELETE SET NULL,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id text REFERENCES work_conversations(id) ON DELETE SET NULL,
  source text NOT NULL,
  external_id text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL,
  stage text NOT NULL,
  channel_kind text,
  channel_label text,
  creator jsonb,
  assignee jsonb,
  created_source_at timestamptz,
  updated_source_at timestamptz,
  last_seen_at timestamptz,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_items_device_id ON work_items(device_id);
CREATE INDEX IF NOT EXISTS idx_work_items_runtime_id ON work_items(runtime_id);
CREATE INDEX IF NOT EXISTS idx_work_items_agent_id ON work_items(agent_id);
CREATE INDEX IF NOT EXISTS idx_work_items_conversation_id ON work_items(conversation_id);
CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source);
CREATE INDEX IF NOT EXISTS idx_work_items_stage ON work_items(stage);
CREATE INDEX IF NOT EXISTS idx_work_items_last_seen_at ON work_items(last_seen_at);

CREATE TABLE IF NOT EXISTS work_executions (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  runtime_id text NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  work_item_id text REFERENCES work_items(id) ON DELETE SET NULL,
  conversation_id text REFERENCES work_conversations(id) ON DELETE SET NULL,
  source text NOT NULL,
  external_id text NOT NULL,
  status text NOT NULL,
  queued_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  last_seen_at timestamptz,
  error text,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_executions_device_id ON work_executions(device_id);
CREATE INDEX IF NOT EXISTS idx_work_executions_runtime_id ON work_executions(runtime_id);
CREATE INDEX IF NOT EXISTS idx_work_executions_agent_id ON work_executions(agent_id);
CREATE INDEX IF NOT EXISTS idx_work_executions_work_item_id ON work_executions(work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_executions_conversation_id ON work_executions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_work_executions_source ON work_executions(source);
CREATE INDEX IF NOT EXISTS idx_work_executions_status ON work_executions(status);
CREATE INDEX IF NOT EXISTS idx_work_executions_last_seen_at ON work_executions(last_seen_at);

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
