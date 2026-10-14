ALTER TABLE publication_tasks DROP CONSTRAINT publication_tasks_state_check;
ALTER TABLE publication_tasks ADD CONSTRAINT publication_tasks_state_check CHECK
  (state IN ('queued','validating','ready','rejected','failed','cancelled','expired',
    'publish_queued','publishing','committing','publish_failed','published'));
ALTER TABLE publication_tasks ADD COLUMN publication_result JSONB;
ALTER TABLE publication_tasks ADD COLUMN commit_bytes BIGINT NOT NULL DEFAULT 0 CHECK (commit_bytes>=0);

-- Private intent/checkpoints, never HTTP-supplied receipts. No second copy of
-- candidate file bodies: they are re-materialized and checked on each attempt.
CREATE TABLE publication_commits (
  task_id TEXT PRIMARY KEY REFERENCES publication_tasks(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  confirm_version BOOLEAN NOT NULL,
  manifest JSONB NOT NULL,
  identity JSONB NOT NULL,
  scan_id TEXT NOT NULL UNIQUE,
  package_id TEXT NOT NULL UNIQUE,
  receipt JSONB,
  checkpoint JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX publication_commits_upload ON publication_commits ((identity->>'uploadId'));
