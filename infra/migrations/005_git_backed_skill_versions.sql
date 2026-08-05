CREATE TABLE IF NOT EXISTS publisher_profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  namespace text NOT NULL UNIQUE,
  display_name text NOT NULL,
  contact text NOT NULL DEFAULT '',
  website_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_scans (
  id text PRIMARY KEY,
  skill_id text NOT NULL,
  version text NOT NULL,
  upload_id text NOT NULL,
  status text NOT NULL,
  risk_level text NOT NULL DEFAULT 'low',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  inventory jsonb NOT NULL DEFAULT '[]'::jsonb,
  scanner_version text NOT NULL DEFAULT '',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id text PRIMARY KEY,
  skill_id text NOT NULL,
  skill_name text NOT NULL,
  display_name text NOT NULL,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version text NOT NULL,
  status text NOT NULL DEFAULT 'published',
  package_path text NOT NULL,
  package_file text NOT NULL,
  package_url text NOT NULL,
  package_size bigint NOT NULL DEFAULT 0,
  checksum_sha256 text NOT NULL,
  payload_sha256 text NOT NULL,
  content_hash text,
  signature jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  upload_id text NOT NULL,
  scan_run_id text,
  risk_level text NOT NULL DEFAULT 'low',
  scan_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at timestamptz,
  yanked_at timestamptz,
  deprecated_at timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  storage_backend text NOT NULL DEFAULT 'legacy-fs',
  git_repository_id text,
  git_commit_sha text,
  git_tree_sha text,
  git_tag text,
  artifact_sha256 text,
  UNIQUE(skill_id, version)
);

ALTER TABLE skill_versions
  ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'legacy-fs',
  ADD COLUMN IF NOT EXISTS git_repository_id text,
  ADD COLUMN IF NOT EXISTS git_commit_sha text,
  ADD COLUMN IF NOT EXISTS git_tree_sha text,
  ADD COLUMN IF NOT EXISTS git_tag text,
  ADD COLUMN IF NOT EXISTS artifact_sha256 text;

ALTER TABLE private_skill_versions
  ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'legacy-fs',
  ADD COLUMN IF NOT EXISTS git_repository_id text,
  ADD COLUMN IF NOT EXISTS git_commit_sha text,
  ADD COLUMN IF NOT EXISTS git_tree_sha text,
  ADD COLUMN IF NOT EXISTS git_tag text,
  ADD COLUMN IF NOT EXISTS artifact_sha256 text;

CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_status
  ON skill_versions(skill_id, status, yanked_at);
CREATE INDEX IF NOT EXISTS idx_skill_versions_owner
  ON skill_versions(owner_user_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_versions_content_hash
  ON skill_versions(skill_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_skill_scans_skill_version
  ON skill_scans(skill_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_git_tag
  ON skill_versions(git_repository_id, git_tag)
  WHERE git_repository_id IS NOT NULL AND git_tag IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_private_skill_versions_git_tag
  ON private_skill_versions(git_repository_id, git_tag)
  WHERE git_repository_id IS NOT NULL AND git_tag IS NOT NULL;

ALTER TABLE skill_versions
  DROP CONSTRAINT IF EXISTS skill_versions_storage_backend_valid,
  ADD CONSTRAINT skill_versions_storage_backend_valid
    CHECK (storage_backend IN ('legacy-fs', 'git-v1')),
  DROP CONSTRAINT IF EXISTS skill_versions_git_metadata_valid,
  ADD CONSTRAINT skill_versions_git_metadata_valid
    CHECK (
      storage_backend <> 'git-v1'
      OR (
        git_repository_id ~ '^git_[a-f0-9]{32}$'
        AND git_commit_sha ~ '^[a-f0-9]{40}$'
        AND git_tree_sha ~ '^[a-f0-9]{40}$'
        AND length(git_tag) BETWEEN 2 AND 161
        AND artifact_sha256 ~ '^[a-f0-9]{64}$'
      )
    );

ALTER TABLE private_skill_versions
  DROP CONSTRAINT IF EXISTS private_skill_versions_storage_backend_valid,
  ADD CONSTRAINT private_skill_versions_storage_backend_valid
    CHECK (storage_backend IN ('legacy-fs', 'git-v1')),
  DROP CONSTRAINT IF EXISTS private_skill_versions_git_metadata_valid,
  ADD CONSTRAINT private_skill_versions_git_metadata_valid
    CHECK (
      storage_backend <> 'git-v1'
      OR (
        git_repository_id ~ '^git_[a-f0-9]{32}$'
        AND git_commit_sha ~ '^[a-f0-9]{40}$'
        AND git_tree_sha ~ '^[a-f0-9]{40}$'
        AND length(git_tag) BETWEEN 2 AND 161
        AND artifact_sha256 ~ '^[a-f0-9]{64}$'
      )
    );
