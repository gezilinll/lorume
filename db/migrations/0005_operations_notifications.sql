CREATE TABLE IF NOT EXISTS operations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'notification_delivery'
  )),
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

CREATE TABLE IF NOT EXISTS operation_jobs (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'notification_in_app',
    'notification_email'
  )),
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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_thread_id ON notification_deliveries(thread_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient ON notification_deliveries(recipient_user_id, channel, status);

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
