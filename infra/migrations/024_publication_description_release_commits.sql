-- Isolated commit admission for a retained, human-authorized description copy.
-- This table is deliberately separate from publication_commits: the original
-- candidate receipt and delegated permit must never authorize this candidate.
CREATE TABLE publication_description_release_commits (
  application_id TEXT PRIMARY KEY REFERENCES publication_description_derivations(application_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES publication_description_release_plans(task_id) ON DELETE RESTRICT,
  permit_id TEXT NOT NULL UNIQUE CHECK (permit_id ~ '^pubdescpermit_[a-f0-9]{32}$'),
  target JSONB NOT NULL CHECK (jsonb_typeof(target)='object'),
  manifest JSONB NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  identity JSONB NOT NULL CHECK (jsonb_typeof(identity)='object'),
  state TEXT NOT NULL CHECK (state IN ('queued','publishing','committing','publish_failed','published')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0 AND attempts<=3),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  receipt JSONB,
  checkpoint JSONB,
  publication_result JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK (octet_length(target::text)+octet_length(manifest::text)+octet_length(identity::text)
    +COALESCE(octet_length(receipt::text),0)+COALESCE(octet_length(checkpoint::text),0)
    +COALESCE(octet_length(publication_result::text),0)<=131072)
);

CREATE FUNCTION guard_publication_description_release_commit() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR t.authority_kind IS DISTINCT FROM 'catsco' OR EXISTS(SELECT 1 FROM publication_commits WHERE task_id=NEW.task_id)
    OR EXISTS(SELECT 1 FROM publication_delegated_plans WHERE task_id=NEW.task_id)
  THEN RAISE EXCEPTION 'Description release commit binding mismatch' USING ERRCODE='23514'; END IF;
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
CREATE TRIGGER publication_description_release_commit_guard
  BEFORE INSERT OR UPDATE OR DELETE ON publication_description_release_commits
  FOR EACH ROW EXECUTE FUNCTION guard_publication_description_release_commit();
