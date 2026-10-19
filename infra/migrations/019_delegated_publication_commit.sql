-- Inactive internal commit path. No backfill, HTTP admission or worker enablement.
CREATE TABLE publication_delegated_plans (
  task_id TEXT PRIMARY KEY REFERENCES publication_delegations(task_id) ON DELETE RESTRICT,
  receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  target JSONB NOT NULL CHECK(jsonb_typeof(target)='object'),
  manifest JSONB NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  identity JSONB NOT NULL CHECK(jsonb_typeof(identity)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(octet_length(receipt::text)+octet_length(target::text)+octet_length(manifest::text)+octet_length(identity::text)<=65536)
);
CREATE UNIQUE INDEX publication_delegated_plans_upload ON publication_delegated_plans((target->>'uploadId'));
CREATE TABLE publication_delegated_permits (
  task_id TEXT PRIMARY KEY REFERENCES publication_delegated_plans(task_id) ON DELETE RESTRICT,
  permit_id TEXT NOT NULL UNIQUE CHECK(permit_id ~ '^pubpermit_[a-f0-9]{32}$'),
  proof JSONB NOT NULL CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=8192),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE publication_commits ADD COLUMN delegated_permit_task TEXT UNIQUE
  REFERENCES publication_delegated_permits(task_id) ON DELETE RESTRICT;

CREATE FUNCTION guard_publication_delegated_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t publication_tasks; d publication_delegations; o publication_delegation_outbox;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Delegated release plan is immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO t FROM publication_tasks WHERE id=NEW.task_id FOR UPDATE;
  SELECT * INTO d FROM publication_delegations WHERE task_id=NEW.task_id;
  SELECT * INTO o FROM publication_delegation_outbox WHERE task_id=NEW.task_id;
  IF t.authority_kind IS DISTINCT FROM 'catsco' OR t.state IS DISTINCT FROM 'delegated_pending'
    OR t.candidate IS NULL OR d.task_id IS NULL OR o.task_id IS NULL
    OR NEW.receipt IS DISTINCT FROM jsonb_build_object(
      'schemaVersion',1,'entryRequestId',d.entry_request_id,'candidateRevision',d.candidate_revision,
      'acceptanceEpoch',d.authority_epoch,'requestHash',t.request_hash,'sourceSnapshotHash',t.candidate_hash,
      'requestBytes',d.request_bytes,'delegationId',d.delegation_id,'idempotencyKey',t.request_key,
      'taskId',t.id,'eventId',o.event_id)
    OR NEW.target->>'candidateHash' IS DISTINCT FROM t.candidate_hash
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
  THEN RAISE EXCEPTION 'Delegated plan binding mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_delegated_plan_guard BEFORE INSERT OR UPDATE ON publication_delegated_plans
  FOR EACH ROW EXECUTE FUNCTION guard_publication_delegated_plan();

CREATE FUNCTION guard_publication_delegated_permit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT; p publication_delegated_plans;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Delegated permit is immutable' USING ERRCODE='23514'; END IF;
  SELECT t.state INTO state FROM publication_tasks t WHERE t.id=NEW.task_id FOR UPDATE;
  SELECT * INTO p FROM publication_delegated_plans WHERE task_id=NEW.task_id;
  IF state IS DISTINCT FROM 'delegated_pending' OR p.task_id IS NULL
    OR NEW.proof->'receipt' IS DISTINCT FROM p.receipt OR NEW.proof->'target' IS DISTINCT FROM p.target
    OR NEW.proof->>'permitId' IS DISTINCT FROM NEW.permit_id
    OR NEW.proof->>'schemaVersion' IS DISTINCT FROM '1'
    OR NOT COALESCE((NEW.proof->>'intentHash') ~ '^[a-f0-9]{64}$',false)
    OR NOT COALESCE((NEW.proof->>'authorityEpoch') ~ '^[1-8]$',false)
    OR (NEW.proof->>'authorityEpoch')::int<(p.receipt->>'acceptanceEpoch')::int
    OR NOT COALESCE((NEW.proof->>'authorizedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$',false)
  THEN RAISE EXCEPTION 'Delegated permit binding mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_delegated_permit_guard BEFORE INSERT OR UPDATE ON publication_delegated_permits
  FOR EACH ROW EXECUTE FUNCTION guard_publication_delegated_permit();

CREATE OR REPLACE FUNCTION guard_publication_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT; p publication_delegated_plans;
BEGIN
  SELECT authority_kind INTO kind FROM publication_tasks WHERE id=NEW.task_id FOR UPDATE;
  IF TG_OP='UPDATE' AND (OLD.task_id IS DISTINCT FROM NEW.task_id OR
    OLD.delegated_permit_task IS DISTINCT FROM NEW.delegated_permit_task) THEN
    RAISE EXCEPTION 'Commit binding is immutable' USING ERRCODE='23514';
  END IF;
  IF kind='catsco' THEN
    SELECT plan.* INTO p FROM publication_delegated_plans plan
      JOIN publication_delegated_permits permit USING(task_id) WHERE plan.task_id=NEW.task_id;
    IF p.task_id IS NULL OR NEW.delegated_permit_task IS DISTINCT FROM NEW.task_id
      OR NEW.profile_id IS DISTINCT FROM p.target->>'publisherProfileId'
      OR NEW.namespace IS DISTINCT FROM p.target->>'namespace'
      OR to_jsonb(NEW.confirm_version) IS DISTINCT FROM p.target->'confirmVersionPublish'
      OR NEW.manifest IS DISTINCT FROM p.manifest OR NEW.identity IS DISTINCT FROM p.identity
      OR NEW.receipt IS NULL OR NEW.receipt->'identity' IS DISTINCT FROM p.identity
      OR NEW.receipt->>'candidateHash' IS DISTINCT FROM p.target->>'candidateHash'
      OR NEW.receipt->>'requestHash' IS DISTINCT FROM p.receipt->>'requestHash'
      OR (TG_OP='UPDATE' AND (NEW.scan_id IS DISTINCT FROM OLD.scan_id OR NEW.package_id IS DISTINCT FROM OLD.package_id
        OR NEW.receipt IS DISTINCT FROM OLD.receipt
        OR (OLD.checkpoint IS NOT NULL AND NEW.checkpoint IS DISTINCT FROM OLD.checkpoint)))
    THEN RAISE EXCEPTION 'Delegated commit requires exact retained permit' USING ERRCODE='23514'; END IF;
  ELSIF NEW.delegated_permit_task IS NOT NULL THEN
    RAISE EXCEPTION 'Account commit cannot use delegated permit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE publication_tasks DROP CONSTRAINT publication_tasks_authority_state;
ALTER TABLE publication_tasks ADD CONSTRAINT publication_tasks_authority_state CHECK (
 (authority_kind='account' AND state<>'delegated_pending' AND delegated_cancelled_at IS NULL) OR
 (authority_kind='catsco' AND (
   (state='delegated_pending' AND delegated_cancelled_at IS NULL AND lease_token IS NULL AND lease_until IS NULL AND publication_result IS NULL) OR
   (state='cancelled' AND delegated_cancelled_at IS NOT NULL AND candidate IS NULL AND candidate_bytes=0 AND lease_token IS NULL AND lease_until IS NULL AND publication_result IS NULL) OR
   (state IN ('publish_queued','committing','publish_failed','published') AND delegated_cancelled_at IS NULL
     AND (publication_result IS NULL OR state='published'))))
);

CREATE OR REPLACE FUNCTION guard_publication_task_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.authority_kind IS DISTINCT FROM OLD.authority_kind OR
  (OLD.authority_kind='catsco' AND (
   NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.request_key IS DISTINCT FROM OLD.request_key OR
   NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.candidate_hash IS DISTINCT FROM OLD.candidate_hash OR
   (NEW.candidate IS NOT NULL AND NEW.candidate IS DISTINCT FROM OLD.candidate) OR
   (OLD.state='cancelled' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.delegated_cancelled_at IS DISTINCT FROM OLD.delegated_cancelled_at)) OR
   (OLD.state IN ('publish_queued','committing','publish_failed','published') AND NEW.state IN ('delegated_pending','cancelled'))
  ))) THEN RAISE EXCEPTION 'Publication authority or cancellation is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.authority_kind='catsco' AND NEW.state IN ('publish_queued','committing','publish_failed','published') AND
  NOT EXISTS(SELECT 1 FROM publication_commits c JOIN publication_delegated_permits p ON p.task_id=c.delegated_permit_task WHERE c.task_id=NEW.id)
 THEN RAISE EXCEPTION 'Delegated execution requires committed permit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;

DROP TRIGGER publication_task_authority_immutable ON publication_tasks;
CREATE TRIGGER publication_task_authority_immutable BEFORE INSERT OR UPDATE ON publication_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_publication_task_authority();

