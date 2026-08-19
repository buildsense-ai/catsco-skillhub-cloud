CREATE TABLE IF NOT EXISTS private_skill_mutations (
  id TEXT PRIMARY KEY,
  authority TEXT NOT NULL,
  owner_bot_id TEXT NOT NULL,
  mutation_id BIGINT NOT NULL,
  grant_id TEXT NOT NULL,
  local_skill_id TEXT NOT NULL,
  actor_user_id BIGINT NOT NULL,
  source_topic_id TEXT NOT NULL,
  source_message_id BIGINT NOT NULL,
  runtime_body_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  candidate_content_hash TEXT NOT NULL,
  candidate_size_bytes BIGINT NOT NULL,
  expected_previous_content_hash TEXT NOT NULL DEFAULT '',
  before_reference JSONB,
  request_fingerprint TEXT NOT NULL,
  private_skill_version_id TEXT NOT NULL REFERENCES private_skill_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending',
  failure_code TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  UNIQUE (authority, owner_bot_id, mutation_id),
  UNIQUE (authority, owner_bot_id, client_request_id),
  CONSTRAINT private_skill_mutations_authority_valid CHECK (length(authority) BETWEEN 1 AND 2048),
  CONSTRAINT private_skill_mutations_owner_bot_id_valid CHECK (length(owner_bot_id) BETWEEN 1 AND 160),
  CONSTRAINT private_skill_mutations_id_valid CHECK (mutation_id > 0),
  CONSTRAINT private_skill_mutations_grant_valid CHECK (length(grant_id) BETWEEN 1 AND 256),
  CONSTRAINT private_skill_mutations_local_skill_valid CHECK (local_skill_id ~ '^[A-Za-z0-9._:-]{1,160}$'),
  CONSTRAINT private_skill_mutations_operation_valid CHECK (operation IN ('create', 'replace')),
  CONSTRAINT private_skill_mutations_hash_valid CHECK (candidate_content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT private_skill_mutations_size_valid CHECK (candidate_size_bytes > 0),
  CONSTRAINT private_skill_mutations_status_valid CHECK (status IN ('pending', 'active', 'rejected'))
);

CREATE INDEX IF NOT EXISTS private_skill_mutations_version_idx
  ON private_skill_mutations(private_skill_version_id);

CREATE INDEX IF NOT EXISTS private_skill_mutations_pending_idx
  ON private_skill_mutations(status, updated_at)
  WHERE status = 'pending';

DO $$
BEGIN
  IF to_regclass('private_skill_mutations') IS NULL THEN
    RAISE EXCEPTION 'private Skill mutation table was not created';
  END IF;
END
$$;

-- Pending rows created before the lease column existed must be recoverable.
-- Setting their lease to the last durable update makes the next reservation
-- re-arm them through the existing retry path instead of leaving them stuck.
UPDATE private_skill_versions
SET lease_expires_at = updated_at
WHERE status = 'pending' AND lease_expires_at IS NULL;
