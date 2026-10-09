-- Skill visibility is attached to the logical skill, so every published
-- version inherits the same discovery and download policy.
ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS visibility_scope TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS visibility_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS visibility_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE skills
  DROP CONSTRAINT IF EXISTS skills_visibility_scope_valid,
  ADD CONSTRAINT skills_visibility_scope_valid
    CHECK (visibility_scope IN ('public', 'shared', 'private')),
  DROP CONSTRAINT IF EXISTS skills_visibility_revision_valid,
  ADD CONSTRAINT skills_visibility_revision_valid
    CHECK (visibility_revision > 0);

CREATE TABLE IF NOT EXISTS skill_visibility_grants (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  catsco_uid TEXT NOT NULL,
  -- This is the current grant writer, not the grant's owner. Keep the
  -- visibility rule when that account is removed, while dropping the stale
  -- audit pointer instead of blocking account deletion.
  granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, catsco_uid),
  CONSTRAINT skill_visibility_grants_uid_valid
    CHECK (catsco_uid ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);

CREATE INDEX IF NOT EXISTS skill_visibility_grants_uid_idx
  ON skill_visibility_grants(catsco_uid, skill_id);

-- Rows created before this migration are intentionally public. The defaults
-- above make the rollout additive and do not hide an existing Skill.
