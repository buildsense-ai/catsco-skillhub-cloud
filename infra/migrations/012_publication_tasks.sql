-- Private, opt-in validation tasks. No relation to the legacy publishing queue.
CREATE TABLE publication_tasks (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  candidate_hash TEXT,
  candidate BYTEA,
  candidate_bytes BIGINT NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('queued','validating','ready','rejected','failed','cancelled','expired')),
  intake_result JSONB NOT NULL,
  validation_result JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ NOT NULL,
  UNIQUE(owner_user_id, request_key),
  CHECK (candidate_bytes = COALESCE(octet_length(candidate), 0)),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (purge_after > expires_at)
);
CREATE INDEX publication_tasks_runnable ON publication_tasks(state, run_after, lease_until);
CREATE INDEX publication_tasks_expiration ON publication_tasks(expires_at);
CREATE INDEX publication_tasks_purge ON publication_tasks(purge_after);
