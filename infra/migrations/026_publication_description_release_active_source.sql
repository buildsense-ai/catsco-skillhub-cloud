-- Do not admit or advance a derived release after its delegated source was
-- cancelled. The task-row lock serializes these checks with cancellation.
CREATE OR REPLACE FUNCTION guard_publication_description_release_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p publication_description_release_plans; a publication_description_release_authorizations; t publication_tasks;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Description release admission is immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO p FROM publication_description_release_plans WHERE application_id=NEW.application_id AND task_id=NEW.task_id;
  SELECT * INTO a FROM publication_description_release_authorizations WHERE application_id=NEW.application_id AND task_id=NEW.task_id;
  SELECT * INTO t FROM publication_tasks WHERE id=NEW.task_id FOR UPDATE;
  IF p.application_id IS NULL OR a.state IS DISTINCT FROM 'permitted'
    OR a.proof IS DISTINCT FROM NEW.proof OR a.proof->>'permitId' IS DISTINCT FROM NEW.permit_id
    OR NEW.proof->'target' IS DISTINCT FROM p.target
    OR NEW.proof->>'applicationId' IS DISTINCT FROM NEW.application_id
    OR NEW.proof->>'entryId' IS DISTINCT FROM p.receipt->>'entryRequestId'
    OR NOT COALESCE((NEW.proof->>'intentHash') ~ '^[a-f0-9]{64}$',false)
    OR t.id IS NULL OR t.authority_kind IS DISTINCT FROM 'catsco'
    OR t.state IS DISTINCT FROM 'delegated_pending' OR t.delegated_cancelled_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM publication_commits WHERE task_id=NEW.task_id)
    OR EXISTS(SELECT 1 FROM publication_delegated_plans WHERE task_id=NEW.task_id)
  THEN RAISE EXCEPTION 'Derived release admission does not match an active retained permit' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_publication_description_release_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p publication_description_release_plans; a publication_description_release_admissions;
  d publication_description_derivations; t publication_tasks;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Description release commit is retained' USING ERRCODE='23514';
  END IF;
  SELECT * INTO p FROM publication_description_release_plans WHERE application_id=NEW.application_id AND task_id=NEW.task_id;
  SELECT * INTO a FROM publication_description_release_admissions WHERE application_id=NEW.application_id AND task_id=NEW.task_id;
  SELECT * INTO d FROM publication_description_derivations WHERE application_id=NEW.application_id;
  SELECT * INTO t FROM publication_tasks WHERE id=NEW.task_id FOR UPDATE;
  IF p.application_id IS NULL OR a.application_id IS NULL OR d.application_id IS NULL OR t.id IS NULL
    OR a.permit_id IS DISTINCT FROM NEW.permit_id OR a.proof->'target' IS DISTINCT FROM NEW.target
    OR NEW.target IS DISTINCT FROM p.target OR NEW.manifest IS DISTINCT FROM p.manifest
    OR NEW.identity IS DISTINCT FROM p.identity OR NEW.target->>'candidateHash' IS DISTINCT FROM d.derived_candidate_hash
    OR t.authority_kind IS DISTINCT FROM 'catsco' OR t.state IS DISTINCT FROM 'delegated_pending'
    OR t.delegated_cancelled_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM publication_commits WHERE task_id=NEW.task_id)
    OR EXISTS(SELECT 1 FROM publication_delegated_plans WHERE task_id=NEW.task_id)
  THEN RAISE EXCEPTION 'Description release commit binding mismatch or source is inactive' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'queued' OR NEW.attempts<>0 OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
      OR NEW.receipt IS NOT NULL OR NEW.checkpoint IS NOT NULL OR NEW.publication_result IS NOT NULL OR NEW.error_code IS NOT NULL
    THEN RAISE EXCEPTION 'Description release commit must begin queued' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.application_id IS DISTINCT FROM NEW.application_id OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.permit_id IS DISTINCT FROM NEW.permit_id OR OLD.target IS DISTINCT FROM NEW.target
    OR OLD.manifest IS DISTINCT FROM NEW.manifest OR OLD.identity IS DISTINCT FROM NEW.identity
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN RAISE EXCEPTION 'Description release commit identity is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.attempts<OLD.attempts OR NEW.attempts>3 THEN RAISE EXCEPTION 'Description release commit attempts invalid' USING ERRCODE='23514'; END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
