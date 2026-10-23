-- Independently retained candidates produced from a CatsCo-confirmed
-- description proposal. This table is deliberately separate from the task
-- state machine: deriving a copy never publishes, authorizes, or mutates the
-- original candidate.
CREATE TABLE publication_description_derivations (
  application_id TEXT PRIMARY KEY CHECK (application_id ~ '^pubdesc_[a-f0-9]{64}$'),
  task_id TEXT NOT NULL REFERENCES publication_tasks(id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  candidate_hash TEXT NOT NULL CHECK (candidate_hash ~ '^[a-f0-9]{64}$'),
  proposal JSONB NOT NULL CHECK (jsonb_typeof(proposal)='object'),
  proposal_digest TEXT NOT NULL CHECK (proposal_digest ~ '^[a-f0-9]{64}$'),
  derived_request_hash TEXT NOT NULL CHECK (derived_request_hash ~ '^[a-f0-9]{64}$'),
  derived_candidate_hash TEXT NOT NULL CHECK (derived_candidate_hash ~ '^[a-f0-9]{64}$'),
  derived_raw_json BYTEA NOT NULL,
  derived_bytes BIGINT NOT NULL CHECK (derived_bytes = octet_length(derived_raw_json) AND derived_bytes > 0),
  derivation_receipt JSONB NOT NULL CHECK (jsonb_typeof(derivation_receipt)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id, proposal_digest),
  UNIQUE(task_id, derived_candidate_hash)
);
CREATE INDEX publication_description_derivations_task ON publication_description_derivations(task_id);

CREATE FUNCTION guard_publication_description_derivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM publication_tasks t
    WHERE t.id=NEW.task_id AND t.authority_kind='catsco'
      AND t.request_hash=NEW.request_hash AND t.candidate_hash=NEW.candidate_hash
      AND t.candidate IS NOT NULL AND t.candidate_bytes=octet_length(t.candidate)
  ) THEN
    RAISE EXCEPTION 'Description derivation source binding mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.derivation_receipt->>'derivedRequestHash' IS DISTINCT FROM NEW.derived_request_hash
    OR NEW.derivation_receipt->>'derivedCandidateHash' IS DISTINCT FROM NEW.derived_candidate_hash
    OR NEW.derivation_receipt->>'proposalDigest' IS DISTINCT FROM NEW.proposal_digest
  THEN RAISE EXCEPTION 'Description derivation receipt mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_description_derivation_guard
  BEFORE INSERT OR UPDATE ON publication_description_derivations
  FOR EACH ROW EXECUTE FUNCTION guard_publication_description_derivation();

CREATE FUNCTION guard_publication_description_derivation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Description derivation is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER publication_description_derivation_immutable
  BEFORE UPDATE OR DELETE ON publication_description_derivations
  FOR EACH ROW EXECUTE FUNCTION guard_publication_description_derivation_immutable();
