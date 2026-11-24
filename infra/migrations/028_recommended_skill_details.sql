CREATE TABLE IF NOT EXISTS recommended_skill_details (
  package_version_id text PRIMARY KEY REFERENCES skill_versions(id) ON DELETE CASCADE,
  source_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_id uuid,
  due_at timestamptz NOT NULL DEFAULT now(),
  content jsonb,
  revision integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  failure_code text
);
