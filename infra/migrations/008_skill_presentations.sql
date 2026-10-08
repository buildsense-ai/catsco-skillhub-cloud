-- Presentation metadata is independent of immutable skill_versions content.
CREATE TABLE IF NOT EXISTS skill_presentations (
  package_version_id TEXT PRIMARY KEY REFERENCES skill_versions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  draft_content JSONB NOT NULL CHECK (jsonb_typeof(draft_content) = 'object'),
  draft_origin TEXT NOT NULL CHECK (draft_origin IN ('author', 'admin')),
  published_content JSONB CHECK (jsonb_typeof(published_content) = 'object'),
  published_origin TEXT CHECK (published_origin IN ('author', 'admin')),
  published_revision INTEGER,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((published_content IS NULL AND published_revision IS NULL AND published_at IS NULL AND published_origin IS NULL)
    OR (published_content IS NOT NULL AND published_revision IS NOT NULL AND published_revision > 0
      AND published_revision <= revision AND published_at IS NOT NULL AND published_origin IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS skill_presentation_revisions (
  package_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  action TEXT NOT NULL CHECK (action IN ('draft', 'publish', 'unpublish')),
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  actor_user_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (package_version_id, revision)
);
