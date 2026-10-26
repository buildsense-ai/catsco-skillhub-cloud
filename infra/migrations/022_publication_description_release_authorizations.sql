-- Durable Cloud-side consumption of CatsCo's independent derived-release
-- permit. Pending attempts are a cancellation fence because an HTTP timeout
-- cannot prove that CatsCo did not issue the permit.
CREATE TABLE publication_description_release_authorizations (
  application_id TEXT PRIMARY KEY REFERENCES publication_description_release_plans(application_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES publication_description_release_plans(task_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pending','permitted','denied')),
  proof JSONB CHECK (proof IS NULL OR (jsonb_typeof(proof)='object' AND octet_length(proof::text)<=8192)),
  terminal_code TEXT CHECK (terminal_code IS NULL OR terminal_code IN ('denied','cancelled','conflict','publisher_changed','source_unavailable')),
  attempt_token TEXT CHECK (attempt_token IS NULL OR attempt_token ~ '^pubdescattempt_[0-9a-f-]{36}$'),
  attempt_lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((attempt_token IS NULL)=(attempt_lease_until IS NULL)),
  CHECK ((state='pending' AND proof IS NULL AND terminal_code IS NULL AND attempt_token IS NOT NULL)
      OR (state='permitted' AND proof IS NOT NULL AND terminal_code IS NULL AND attempt_token IS NULL)
      OR (state='denied' AND proof IS NULL AND terminal_code IS NOT NULL AND attempt_token IS NULL))
);

CREATE FUNCTION guard_publication_description_release_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t publication_tasks; p publication_description_release_plans;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Description release authorization is retained' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' OR NEW.proof IS NOT NULL OR NEW.terminal_code IS NOT NULL
      OR NEW.attempt_token IS NULL OR NEW.attempt_lease_until<=clock_timestamp()
      OR NEW.attempt_lease_until>clock_timestamp()+interval '20 seconds' THEN
      RAISE EXCEPTION 'Description release authorization must begin pending' USING ERRCODE='23514';
    END IF;
    SELECT * INTO t FROM publication_tasks WHERE id=NEW.task_id FOR UPDATE;
    SELECT * INTO p FROM publication_description_release_plans WHERE task_id=NEW.task_id;
    IF t.id IS NULL OR t.authority_kind IS DISTINCT FROM 'catsco' OR t.state IS DISTINCT FROM 'delegated_pending'
      OR t.candidate IS NULL OR t.expires_at<=clock_timestamp() OR p.application_id IS DISTINCT FROM NEW.application_id
      OR p.task_id IS DISTINCT FROM NEW.task_id OR EXISTS(SELECT 1 FROM publication_commits WHERE task_id=NEW.task_id)
      OR EXISTS(SELECT 1 FROM publication_delegated_plans WHERE task_id=NEW.task_id)
    THEN RAISE EXCEPTION 'Description release authorization has no live plan' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.application_id IS DISTINCT FROM NEW.application_id OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.state IS DISTINCT FROM 'pending'
    OR OLD.proof IS NOT NULL OR OLD.terminal_code IS NOT NULL
  THEN RAISE EXCEPTION 'Description release authorization transition is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.state='pending' THEN
    IF NEW.proof IS NOT NULL OR NEW.terminal_code IS NOT NULL OR NEW.attempt_token IS NULL
      OR NEW.attempt_lease_until IS NULL OR NEW.attempt_lease_until>clock_timestamp()+interval '20 seconds'
      OR (OLD.attempt_lease_until>clock_timestamp() AND NEW.attempt_token IS DISTINCT FROM OLD.attempt_token)
    THEN RAISE EXCEPTION 'Description release authorization lease is invalid' USING ERRCODE='23514'; END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.state NOT IN ('permitted','denied') OR NEW.attempt_token IS NOT NULL OR NEW.attempt_lease_until IS NOT NULL
  THEN RAISE EXCEPTION 'Description release authorization transition is invalid' USING ERRCODE='23514'; END IF;
  SELECT * INTO p FROM publication_description_release_plans WHERE application_id=NEW.application_id AND task_id=NEW.task_id;
  IF p.application_id IS NULL THEN RAISE EXCEPTION 'Description release plan is unavailable' USING ERRCODE='23514'; END IF;
  IF NEW.state='permitted' THEN
    IF NEW.terminal_code IS NOT NULL
      OR NEW.proof IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'entryId',p.receipt->>'entryRequestId',
        'applicationId',NEW.application_id,'target',p.target,'intentHash',NEW.proof->>'intentHash',
        'permitId',NEW.proof->>'permitId','authorizedAt',NEW.proof->>'authorizedAt')
      OR NEW.proof->>'schemaVersion' IS DISTINCT FROM '1'
      OR NEW.proof->>'entryId' IS DISTINCT FROM p.receipt->>'entryRequestId'
      OR NEW.proof->>'applicationId' IS DISTINCT FROM NEW.application_id
      OR NEW.proof->'target' IS DISTINCT FROM p.target
      OR NOT COALESCE((NEW.proof->>'intentHash') ~ '^[a-f0-9]{64}$',false)
      OR NOT COALESCE((NEW.proof->>'permitId') ~ '^pubdescpermit_[a-f0-9]{32}$',false)
      OR NOT COALESCE((NEW.proof->>'authorizedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$',false)
    THEN RAISE EXCEPTION 'Description release permit proof does not match its retained plan' USING ERRCODE='23514'; END IF;
  ELSIF NEW.proof IS NOT NULL OR NEW.terminal_code IS NULL THEN
    RAISE EXCEPTION 'Denied description release authorization has invalid evidence' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_description_release_authorization_guard
  BEFORE INSERT OR UPDATE OR DELETE ON publication_description_release_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_publication_description_release_authorization();

-- Serialize direct task cancellation with pending/retained Cloud authorization,
-- even when a caller bypasses the application cancellation adapter.
CREATE FUNCTION guard_publication_description_release_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.authority_kind='catsco' AND OLD.state IS DISTINCT FROM 'cancelled' AND NEW.state='cancelled'
    AND EXISTS(SELECT 1 FROM publication_description_release_authorizations a
      WHERE a.task_id=OLD.id AND a.state IN ('pending','permitted'))
  THEN RAISE EXCEPTION 'Description release authorization blocks cancellation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_description_release_cancellation_guard
  BEFORE UPDATE OF state ON publication_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_publication_description_release_cancellation();
