-- Independent plan for a retained description-derived candidate. The original
-- upload receipt stays unchanged; neither table is a commit authorization.
CREATE TABLE publication_description_release_plans (
  application_id TEXT PRIMARY KEY REFERENCES publication_description_derivations(application_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES publication_delegations(task_id) ON DELETE RESTRICT,
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  copy_request JSONB NOT NULL CHECK (jsonb_typeof(copy_request)='object'),
  target JSONB NOT NULL CHECK (jsonb_typeof(target)='object'),
  manifest JSONB NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  identity JSONB NOT NULL CHECK (jsonb_typeof(identity)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (octet_length(receipt::text)+octet_length(copy_request::text)+octet_length(target::text)
    +octet_length(manifest::text)+octet_length(identity::text)<=98304)
);
CREATE UNIQUE INDEX publication_description_release_upload ON publication_description_release_plans((target->>'uploadId'));

CREATE FUNCTION guard_publication_description_release_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t publication_tasks; d publication_delegations; o publication_delegation_outbox;
  a publication_description_derivations;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Description release plan is immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO t FROM publication_tasks WHERE id=NEW.task_id FOR UPDATE;
  SELECT * INTO d FROM publication_delegations WHERE task_id=NEW.task_id;
  SELECT * INTO o FROM publication_delegation_outbox WHERE task_id=NEW.task_id;
  SELECT * INTO a FROM publication_description_derivations WHERE application_id=NEW.application_id;
  IF t.authority_kind IS DISTINCT FROM 'catsco' OR t.state IS DISTINCT FROM 'delegated_pending'
    OR t.candidate IS NULL OR t.expires_at<=clock_timestamp() OR d.task_id IS NULL OR o.task_id IS NULL
    OR EXISTS(SELECT 1 FROM publication_delegated_plans WHERE task_id=NEW.task_id)
    OR EXISTS(SELECT 1 FROM publication_commits WHERE task_id=NEW.task_id)
    OR a.task_id IS DISTINCT FROM NEW.task_id OR a.request_hash IS DISTINCT FROM t.request_hash
    OR a.candidate_hash IS DISTINCT FROM t.candidate_hash
    OR NEW.receipt IS DISTINCT FROM jsonb_build_object(
      'schemaVersion',1,'entryRequestId',d.entry_request_id,'candidateRevision',d.candidate_revision,
      'acceptanceEpoch',d.authority_epoch,'requestHash',t.request_hash,'sourceSnapshotHash',t.candidate_hash,
      'requestBytes',d.request_bytes,'delegationId',d.delegation_id,'idempotencyKey',t.request_key,
      'taskId',t.id,'eventId',o.event_id)
    OR NEW.copy_request IS DISTINCT FROM jsonb_build_object(
      'schemaVersion',1,'applicationId',a.application_id,'taskId',a.task_id,'requestHash',a.request_hash,
      'candidateHash',a.candidate_hash,'proposal',a.proposal,'expectedReceipt',a.derivation_receipt,'derivedBytes',a.derived_bytes)
    OR NEW.target->>'candidateHash' IS DISTINCT FROM a.derived_candidate_hash
    OR NEW.target->>'publisherUserId' IS DISTINCT FROM t.owner_user_id
    OR NEW.target->>'publisherProfileId' IS DISTINCT FROM d.profile_id
    OR NEW.target->>'namespace' IS DISTINCT FROM d.namespace
    OR NEW.target->>'skillId' IS DISTINCT FROM NEW.manifest->>'id'
    OR NEW.target->>'version' IS DISTINCT FROM NEW.manifest->>'version'
    OR NEW.identity IS DISTINCT FROM jsonb_build_object('ownerId',t.owner_user_id,
      'uploadId',NEW.target->>'uploadId','skillId',NEW.target->>'skillId',
      'version',NEW.target->>'version','releaseAt',NEW.target->>'releaseAt')
    OR NOT EXISTS(SELECT 1 FROM publication_version_reservations r WHERE r.upload_id=NEW.target->>'uploadId'
      AND r.skill_id=NEW.target->>'skillId' AND r.version=NEW.target->>'version' AND r.owner_user_id=t.owner_user_id)
  THEN RAISE EXCEPTION 'Description release plan binding mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_description_release_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON publication_description_release_plans
  FOR EACH ROW EXECUTE FUNCTION guard_publication_description_release_plan();

-- The original-candidate path cannot allocate a competing plan for this task.
CREATE FUNCTION guard_publication_original_plan_excludes_description() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM publication_tasks WHERE id=NEW.task_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM publication_description_release_plans WHERE task_id=NEW.task_id) THEN
    RAISE EXCEPTION 'Description release plan already exists' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_original_plan_excludes_description BEFORE INSERT ON publication_delegated_plans
  FOR EACH ROW EXECUTE FUNCTION guard_publication_original_plan_excludes_description();
