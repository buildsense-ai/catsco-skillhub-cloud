ALTER TABLE private_skill_versions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

UPDATE private_skill_versions
SET updated_at = COALESCE(updated_at, created_at, now()),
    attempt_count = COALESCE(attempt_count, 1);

ALTER TABLE private_skill_versions
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN attempt_count SET DEFAULT 1,
  ALTER COLUMN attempt_count SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skills'::regclass AND conname = 'private_skills_authority_valid') THEN
    ALTER TABLE private_skills ADD CONSTRAINT private_skills_authority_valid CHECK (length(authority) BETWEEN 1 AND 2048);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skills'::regclass AND conname = 'private_skills_owner_bot_id_valid') THEN
    ALTER TABLE private_skills ADD CONSTRAINT private_skills_owner_bot_id_valid CHECK (length(owner_bot_id) BETWEEN 1 AND 160);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skills'::regclass AND conname = 'private_skills_local_skill_id_valid') THEN
    ALTER TABLE private_skills ADD CONSTRAINT private_skills_local_skill_id_valid CHECK (local_skill_id ~ '^[A-Za-z0-9._:-]{1,160}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skills'::regclass AND conname = 'private_skills_skill_id_valid') THEN
    ALTER TABLE private_skills ADD CONSTRAINT private_skills_skill_id_valid CHECK (skill_id ~ '^priv_[a-f0-9]{40}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skill_versions'::regclass AND conname = 'private_skill_versions_version_valid') THEN
    ALTER TABLE private_skill_versions ADD CONSTRAINT private_skill_versions_version_valid CHECK (version ~ '^v_[a-f0-9]{48}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skill_versions'::regclass AND conname = 'private_skill_versions_name_valid') THEN
    ALTER TABLE private_skill_versions ADD CONSTRAINT private_skill_versions_name_valid CHECK (length(name) BETWEEN 1 AND 256);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skill_versions'::regclass AND conname = 'private_skill_versions_content_hash_valid') THEN
    ALTER TABLE private_skill_versions ADD CONSTRAINT private_skill_versions_content_hash_valid CHECK (content_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skill_versions'::regclass AND conname = 'private_skill_versions_origin_valid') THEN
    ALTER TABLE private_skill_versions ADD CONSTRAINT private_skill_versions_origin_valid CHECK (origin IS NULL OR jsonb_typeof(origin) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skill_versions'::regclass AND conname = 'private_skill_versions_status_valid') THEN
    ALTER TABLE private_skill_versions ADD CONSTRAINT private_skill_versions_status_valid CHECK (status IN ('pending', 'active', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skill_versions'::regclass AND conname = 'private_skill_versions_sizes_valid') THEN
    ALTER TABLE private_skill_versions ADD CONSTRAINT private_skill_versions_sizes_valid CHECK (
      package_bytes >= 0
      AND file_count BETWEEN 1 AND 200
      AND total_bytes BETWEEN 0 AND 20971520
      AND attempt_count >= 1
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private_skill_versions'::regclass AND conname = 'private_skill_versions_active_valid') THEN
    ALTER TABLE private_skill_versions ADD CONSTRAINT private_skill_versions_active_valid CHECK (
      status <> 'active'
      OR (
        package_path <> ''
        AND package_sha256 ~ '^[a-f0-9]{64}$'
        AND package_bytes > 0
        AND activated_at IS NOT NULL
      )
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS private_skill_versions_active_reference_idx
  ON private_skill_versions(private_skill_id, version)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS private_skills_owner_idx
  ON private_skills(authority, owner_bot_id);

DO $$
DECLARE
  required_columns INTEGER;
  required_constraints INTEGER;
BEGIN
  SELECT count(*) INTO required_columns
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'private_skill_versions'
    AND column_name IN ('updated_at', 'lease_expires_at', 'attempt_count', 'activated_at');
  IF required_columns <> 4 THEN
    RAISE EXCEPTION 'private Bot Skill recovery columns are incomplete';
  END IF;

  SELECT count(*) INTO required_constraints
  FROM pg_constraint
  WHERE (
    conrelid = 'private_skills'::regclass
    AND conname IN (
      'private_skills_authority_valid',
      'private_skills_owner_bot_id_valid',
      'private_skills_local_skill_id_valid',
      'private_skills_skill_id_valid'
    )
  ) OR (
    conrelid = 'private_skill_versions'::regclass
    AND conname IN (
      'private_skill_versions_version_valid',
      'private_skill_versions_name_valid',
      'private_skill_versions_content_hash_valid',
      'private_skill_versions_origin_valid',
      'private_skill_versions_status_valid',
      'private_skill_versions_sizes_valid',
      'private_skill_versions_active_valid'
    )
  );
  IF required_constraints <> 11 THEN
    RAISE EXCEPTION 'private Bot Skill constraints are incomplete';
  END IF;
END
$$;
