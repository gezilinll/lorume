CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_members_user_id ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_organization_id ON organization_members(organization_id);

CREATE TABLE IF NOT EXISTS email_login_codes (
  id text PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  purpose text NOT NULL DEFAULT 'login',
  expires_at timestamptz,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_login_codes_email_created_at ON email_login_codes(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_login_codes_expires_at ON email_login_codes(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  token_hash text NOT NULL UNIQUE,
  invited_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organization_invitations_email ON organization_invitations(email);
CREATE INDEX IF NOT EXISTS idx_organization_invitations_organization_id ON organization_invitations(organization_id);

CREATE TABLE IF NOT EXISTS device_tokens (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id text,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_ciphertext text,
  token_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'occupied', 'revoked', 'expired')),
  expires_at timestamptz,
  occupied_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE device_tokens
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'occupied', 'revoked', 'expired'));

ALTER TABLE device_tokens
  ADD COLUMN IF NOT EXISTS occupied_at timestamptz;

ALTER TABLE device_tokens
  ADD COLUMN IF NOT EXISTS token_ciphertext text;

ALTER TABLE organization_invitations
  ALTER COLUMN expires_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_tokens_organization_id ON device_tokens(organization_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_device_id ON device_tokens(device_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_token_prefix ON device_tokens(token_prefix);

CREATE TABLE IF NOT EXISTS organization_audit_events (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organization_audit_events_organization_created_at
  ON organization_audit_events(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_organization_audit_events_event_type
  ON organization_audit_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  os text NOT NULL,
  architecture text,
  collection_status text NOT NULL DEFAULT 'syncing',
  collector jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  collected_at timestamptz NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS organization_id text REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_devices_organization_id ON devices(organization_id);

CREATE TABLE IF NOT EXISTS runtimes (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  collection_status text NOT NULL,
  version text,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtimes_device_id ON runtimes(device_id);
CREATE INDEX IF NOT EXISTS idx_runtimes_kind ON runtimes(kind);
CREATE INDEX IF NOT EXISTS idx_runtimes_collection_status ON runtimes(collection_status);
CREATE INDEX IF NOT EXISTS idx_runtimes_last_seen_at ON runtimes(last_seen_at);

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  runtime_id text NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
  name text NOT NULL,
  collection_status text NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_runtime_id ON agents(runtime_id);
CREATE INDEX IF NOT EXISTS idx_agents_collection_status ON agents(collection_status);
CREATE INDEX IF NOT EXISTS idx_agents_last_seen_at ON agents(last_seen_at);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_type text NOT NULL DEFAULT 'conversation',
  user_message text,
  agent_reply text,
  status text NOT NULL,
  channel jsonb NOT NULL DEFAULT '{}'::jsonb,
  conversation jsonb NOT NULL DEFAULT '{}'::jsonb,
  creator jsonb,
  assignee jsonb,
  error text,
  created_source_at timestamptz,
  updated_source_at timestamptz,
  sync_hash text,
  stale_at timestamptz,
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
CREATE INDEX IF NOT EXISTS idx_tasks_stale_at ON tasks(stale_at);

CREATE TABLE IF NOT EXISTS collector_ingestions (
  id bigserial PRIMARY KEY,
  device_id text NOT NULL,
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  snapshot_type text NOT NULL,
  status text NOT NULL,
  collected_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE collector_ingestions
  ADD COLUMN IF NOT EXISTS organization_id text REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_collector_ingestions_device_id ON collector_ingestions(device_id);
CREATE INDEX IF NOT EXISTS idx_collector_ingestions_organization_id ON collector_ingestions(organization_id);
CREATE INDEX IF NOT EXISTS idx_collector_ingestions_snapshot_type ON collector_ingestions(snapshot_type);
CREATE INDEX IF NOT EXISTS idx_collector_ingestions_received_at ON collector_ingestions(received_at);

CREATE TABLE IF NOT EXISTS operations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('notification_delivery', 'collector_upgrade', 'agent_analysis')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued',
    'running',
    'succeeded',
    'failed',
    'unsupported',
    'requires_manual_step',
    'cancelled'
  )),
  resource_type text,
  resource_id text,
  target_type text,
  target_id text,
  requested_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  summary text NOT NULL,
  error_summary text,
  manual_instruction text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operations_organization_status ON operations(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_operations_resource ON operations(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_operations_target ON operations(target_type, target_id);

ALTER TABLE operations
  DROP CONSTRAINT IF EXISTS operations_type_check;
ALTER TABLE operations
  ADD CONSTRAINT operations_type_check CHECK (type IN ('notification_delivery', 'collector_upgrade', 'agent_analysis'));

CREATE TABLE IF NOT EXISTS operation_jobs (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('notification_in_app', 'notification_email', 'collector_upgrade_device', 'agent_analysis_openclaw')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued',
    'running',
    'succeeded',
    'failed',
    'unsupported',
    'requires_manual_step',
    'cancelled'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_error_summary text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operation_jobs_claim
  ON operation_jobs(status, run_after, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_operation_jobs_operation_id ON operation_jobs(operation_id);

ALTER TABLE operation_jobs
  DROP CONSTRAINT IF EXISTS operation_jobs_type_check;
ALTER TABLE operation_jobs
  ADD CONSTRAINT operation_jobs_type_check CHECK (type IN ('notification_in_app', 'notification_email', 'collector_upgrade_device', 'agent_analysis_openclaw'));

CREATE TABLE IF NOT EXISTS agent_analysis_reports (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operation_id text NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  runtime_id text NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  runtime_kind text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  prompt_kind text NOT NULL,
  prompt_version text NOT NULL,
  hard_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, agent_id, period_start, period_end, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_agent_analysis_reports_organization_agent_created
  ON agent_analysis_reports(organization_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_analysis_reports_operation_id
  ON agent_analysis_reports(operation_id);

CREATE TABLE IF NOT EXISTS notification_events (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operation_id text REFERENCES operations(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  source_module text NOT NULL CHECK (source_module IN ('runtime', 'auth', 'system')),
  resource_type text,
  resource_id text,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  recipient_user_ids text[] NOT NULL DEFAULT '{}'::text[],
  title text NOT NULL,
  summary text NOT NULL,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_events_organization_id ON notification_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_notification_events_operation_id ON notification_events(operation_id);
CREATE INDEX IF NOT EXISTS idx_notification_events_dedupe_key ON notification_events(dedupe_key);

CREATE TABLE IF NOT EXISTS notification_threads (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'muted')),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  event_type text NOT NULL,
  resource_type text,
  resource_id text,
  title text NOT NULL,
  latest_summary text NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1,
  first_occurred_at timestamptz NOT NULL,
  last_occurred_at timestamptz NOT NULL,
  resolved_at timestamptz,
  cooldown_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_notification_threads_organization_status
  ON notification_threads(organization_id, status, last_occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_threads_resource ON notification_threads(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES notification_threads(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email')),
  recipient_user_id text REFERENCES users(id) ON DELETE SET NULL,
  recipient_address text,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  skip_reason text,
  sent_at timestamptz,
  error_summary text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_thread_id ON notification_deliveries(thread_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient ON notification_deliveries(recipient_user_id, channel, status);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_in_app_read_at
  ON notification_deliveries(recipient_user_id, thread_id, read_at)
  WHERE channel = 'in_app';

CREATE TABLE IF NOT EXISTS notification_preferences (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL DEFAULT '*',
  channel text NOT NULL CHECK (channel IN ('in_app', 'email')),
  enabled boolean NOT NULL DEFAULT true,
  severity_threshold text NOT NULL DEFAULT 'info' CHECK (severity_threshold IN ('info', 'warning', 'critical')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, event_type, channel)
);

CREATE TABLE IF NOT EXISTS agent_skill_probe_snapshots (
  id text PRIMARY KEY,
  device_id text NOT NULL,
  runtime_id text NOT NULL,
  agent_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('unknown', 'succeeded', 'unsupported', 'failed')),
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

CREATE TABLE IF NOT EXISTS runtime_skill_probe_snapshots (
  id text PRIMARY KEY,
  device_id text NOT NULL,
  runtime_id text NOT NULL,
  runtime_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('unknown', 'succeeded', 'unsupported', 'failed')),
  observed_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_skill_probe_snapshots_runtime_id
  ON runtime_skill_probe_snapshots(runtime_id);
CREATE INDEX IF NOT EXISTS idx_runtime_skill_probe_snapshots_device_id
  ON runtime_skill_probe_snapshots(device_id);
CREATE INDEX IF NOT EXISTS idx_runtime_skill_probe_snapshots_status
  ON runtime_skill_probe_snapshots(status);

CREATE TABLE IF NOT EXISTS runtime_schedule_probe_snapshots (
  id text PRIMARY KEY,
  device_id text NOT NULL,
  runtime_id text NOT NULL,
  runtime_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('unknown', 'succeeded', 'unsupported', 'failed')),
  observed_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedules jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_schedule_probe_snapshots_runtime_id
  ON runtime_schedule_probe_snapshots(runtime_id);
CREATE INDEX IF NOT EXISTS idx_runtime_schedule_probe_snapshots_device_id
  ON runtime_schedule_probe_snapshots(device_id);
CREATE INDEX IF NOT EXISTS idx_runtime_schedule_probe_snapshots_status
  ON runtime_schedule_probe_snapshots(status);
