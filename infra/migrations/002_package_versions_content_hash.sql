ALTER TABLE package_versions
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE INDEX IF NOT EXISTS package_versions_skill_content_hash_idx
  ON package_versions(skill_id, content_hash)
  WHERE status = 'published' AND yanked_at IS NULL AND content_hash IS NOT NULL;
