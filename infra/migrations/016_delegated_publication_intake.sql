ALTER TABLE publication_tasks ADD COLUMN authority_kind TEXT NOT NULL DEFAULT 'account';
ALTER TABLE publication_tasks DROP CONSTRAINT publication_tasks_state_check;
ALTER TABLE publication_tasks ADD CONSTRAINT publication_tasks_state_check CHECK
  (state IN ('queued','validating','ready','rejected','failed','cancelled','expired',
    'publish_queued','publishing','committing','publish_failed','published','delegated_pending'));
-- No delegated execution until a subsequent migration implements permits and cancellation.
ALTER TABLE publication_tasks ADD CONSTRAINT publication_tasks_authority_state CHECK
  ((authority_kind='account' AND state<>'delegated_pending') OR
   (authority_kind='catsco' AND state='delegated_pending' AND lease_token IS NULL AND commit_bytes=0));

CREATE FUNCTION guard_publication_task_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authority_kind IS DISTINCT FROM OLD.authority_kind OR
    (OLD.authority_kind='catsco' AND
      (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR
       NEW.request_key IS DISTINCT FROM OLD.request_key OR
       NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
       NEW.candidate_hash IS DISTINCT FROM OLD.candidate_hash OR
       (NEW.candidate IS NOT NULL AND NEW.candidate IS DISTINCT FROM OLD.candidate))) THEN
    RAISE EXCEPTION 'Publication authority binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_task_authority_immutable BEFORE UPDATE ON publication_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_publication_task_authority();
ALTER TABLE publication_tasks ADD CONSTRAINT publication_tasks_id_authority UNIQUE(id,authority_kind);

-- RESTRICT preserves replay evidence, including on account deletion. A later
-- explicit lifecycle protocol must release these held rows before deletion.
CREATE TABLE publication_delegations (
  task_id TEXT PRIMARY KEY REFERENCES publication_tasks(id) ON DELETE RESTRICT,
  authority_kind TEXT NOT NULL DEFAULT 'catsco' CHECK(authority_kind='catsco'),
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  entry_request_id TEXT NOT NULL,
  candidate_revision INTEGER NOT NULL CHECK (candidate_revision=1),
  actor_uid TEXT NOT NULL,
  bot_uid TEXT NOT NULL CHECK (bot_uid<>actor_uid),
  profile_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  authority_epoch BIGINT NOT NULL CHECK (authority_epoch>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer,entry_request_id,candidate_revision),
  FOREIGN KEY(task_id,authority_kind) REFERENCES publication_tasks(id,authority_kind) ON DELETE RESTRICT
);
CREATE TABLE publication_delegation_outbox (
  task_id TEXT PRIMARY KEY REFERENCES publication_delegations(task_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_publication_delegation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Publication association is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER publication_delegation_immutable BEFORE UPDATE ON publication_delegations
  FOR EACH ROW EXECUTE FUNCTION guard_publication_delegation();
