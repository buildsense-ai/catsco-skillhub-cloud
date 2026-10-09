-- Existing installations already applied migration 010. Make the same
-- account-deletion policy effective for those databases as well.
ALTER TABLE skill_visibility_grants
  ALTER COLUMN granted_by_user_id DROP NOT NULL;

ALTER TABLE skill_visibility_grants
  DROP CONSTRAINT IF EXISTS skill_visibility_grants_granted_by_user_id_fkey;

ALTER TABLE skill_visibility_grants
  ADD CONSTRAINT skill_visibility_grants_granted_by_user_id_fkey
  FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Direct package URLs are a hot read path. Keep both legacy and
-- content-addressed lookups indexable while the ACL join is evaluated.
CREATE INDEX IF NOT EXISTS skill_versions_package_path_idx
  ON skill_versions(package_path);

CREATE INDEX IF NOT EXISTS skill_versions_artifact_sha256_idx
  ON skill_versions(artifact_sha256)
  WHERE artifact_sha256 IS NOT NULL;
