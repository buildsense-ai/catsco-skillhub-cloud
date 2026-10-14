-- Public release slots are never recycled: a failed worker may have already
-- written a Git tag. No FK to skills: first publication has no catalogue row.
CREATE TABLE publication_version_reservations (
  upload_id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  requested_version TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);
CREATE INDEX publication_jobs_skill ON jobs ((payload->'manifest'->>'id'))
  WHERE type='publish_skill_version';
