-- Cancellation is terminal for held delegations. This is NOT commit enablement.
ALTER TABLE publication_tasks ADD COLUMN delegated_cancelled_at TIMESTAMPTZ;
ALTER TABLE publication_tasks DROP CONSTRAINT publication_tasks_authority_state;
ALTER TABLE publication_tasks ADD CONSTRAINT publication_tasks_authority_state CHECK (
  (authority_kind='account' AND state<>'delegated_pending' AND delegated_cancelled_at IS NULL) OR
  (authority_kind='catsco' AND lease_token IS NULL AND lease_until IS NULL AND commit_bytes=0 AND publication_result IS NULL AND
    ((state='delegated_pending' AND delegated_cancelled_at IS NULL) OR
     (state='cancelled' AND delegated_cancelled_at IS NOT NULL AND candidate IS NULL AND candidate_bytes=0)))
);

CREATE OR REPLACE FUNCTION guard_publication_task_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authority_kind IS DISTINCT FROM OLD.authority_kind OR
    (OLD.authority_kind='catsco' AND
      (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR
       NEW.request_key IS DISTINCT FROM OLD.request_key OR
       NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
       NEW.candidate_hash IS DISTINCT FROM OLD.candidate_hash OR
       (NEW.candidate IS NOT NULL AND NEW.candidate IS DISTINCT FROM OLD.candidate) OR
       (OLD.state='cancelled' AND (NEW.state IS DISTINCT FROM OLD.state OR
         NEW.delegated_cancelled_at IS DISTINCT FROM OLD.delegated_cancelled_at)))) THEN
    RAISE EXCEPTION 'Publication authority binding or cancellation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Until a permit-aware migration replaces this guard, even an accidental
-- internal commit-store call must not put a held/cancelled task into execution.
CREATE FUNCTION guard_publication_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT;
BEGIN
  SELECT authority_kind INTO kind FROM publication_tasks WHERE id=NEW.task_id FOR UPDATE;
  IF kind='catsco' THEN
    RAISE EXCEPTION 'Delegated publication commit is not enabled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_commit_authority BEFORE INSERT OR UPDATE ON publication_commits
  FOR EACH ROW EXECUTE FUNCTION guard_publication_commit_authority();
