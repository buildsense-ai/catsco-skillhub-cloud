CREATE TABLE IF NOT EXISTS private_skills (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL UNIQUE,
  authority TEXT NOT NULL,
  owner_bot_id TEXT NOT NULL,
  local_skill_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (authority, owner_bot_id, local_skill_id),
  CONSTRAINT private_skills_authority_valid
    CHECK (length(authority) BETWEEN 1 AND 2048),
  CONSTRAINT private_skills_owner_bot_id_valid
    CHECK (length(owner_bot_id) BETWEEN 1 AND 160),
  CONSTRAINT private_skills_local_skill_id_valid
    CHECK (local_skill_id ~ '^[A-Za-z0-9._:-]{1,160}$'),
  CONSTRAINT private_skills_skill_id_valid
    CHECK (skill_id ~ '^priv_[a-f0-9]{40}$')
);

CREATE TABLE IF NOT EXISTS private_skill_versions (
  id TEXT PRIMARY KEY,
  private_skill_id TEXT NOT NULL REFERENCES private_skills(id) ON DELETE RESTRICT,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  origin JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  package_path TEXT NOT NULL DEFAULT '',
  package_sha256 TEXT NOT NULL DEFAULT '',
  package_bytes BIGINT NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL,
  total_bytes BIGINT NOT NULL,
  failure_code TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  activated_at TIMESTAMPTZ,
  UNIQUE (private_skill_id, version),
  UNIQUE (private_skill_id, content_hash),
  CONSTRAINT private_skill_versions_version_valid
    CHECK (version ~ '^v_[a-f0-9]{48}$'),
  CONSTRAINT private_skill_versions_name_valid
    CHECK (length(name) BETWEEN 1 AND 256),
  CONSTRAINT private_skill_versions_content_hash_valid
    CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT private_skill_versions_origin_valid
    CHECK (origin IS NULL OR jsonb_typeof(origin) = 'object'),
  CONSTRAINT private_skill_versions_status_valid
    CHECK (status IN ('pending', 'active', 'rejected')),
  CONSTRAINT private_skill_versions_sizes_valid
    CHECK (
      package_bytes >= 0
      AND file_count BETWEEN 1 AND 200
      AND total_bytes BETWEEN 0 AND 20971520
      AND attempt_count >= 1
    ),
  CONSTRAINT private_skill_versions_active_valid
    CHECK (
      status <> 'active'
      OR (
        package_path <> ''
        AND package_sha256 ~ '^[a-f0-9]{64}$'
        AND package_bytes > 0
        AND activated_at IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS private_skill_versions_active_reference_idx
  ON private_skill_versions(private_skill_id, version)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS private_skills_owner_idx
  ON private_skills(authority, owner_bot_id);

DO $$
BEGIN
  IF to_regclass('private_skills') IS NULL
     OR to_regclass('private_skill_versions') IS NULL THEN
    RAISE EXCEPTION 'private Bot Skill tables were not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'private_skill_versions_active_valid'
      AND conrelid = 'private_skill_versions'::regclass
  ) THEN
    RAISE EXCEPTION 'private Bot Skill constraints are incomplete';
  END IF;
END
$$;
