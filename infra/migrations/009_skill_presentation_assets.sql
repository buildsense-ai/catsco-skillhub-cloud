-- Private by default. Bytes are served only after checking live presentation
-- references and the exact package version's visibility, never as static files.
CREATE TABLE IF NOT EXISTS skill_presentation_assets (
  id TEXT PRIMARY KEY CHECK (id ~ '^pa_[a-f0-9]{32}$'),
  package_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
  data BYTEA NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 2097152),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (width::bigint * height <= 16000000),
  UNIQUE (package_version_id, content_sha256)
);
CREATE INDEX IF NOT EXISTS skill_presentation_assets_actor ON skill_presentation_assets (actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS skill_presentation_asset_upload_rate ON audit_logs (actor_user_id, created_at)
  WHERE action = 'presentation.asset.upload';
