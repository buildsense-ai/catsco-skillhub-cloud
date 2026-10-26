-- A Cloud-side, isolated admission for an exact CatsCo-derived candidate permit.
-- It does not create a legacy commit, publish job, or public package.
CREATE TABLE publication_description_release_admissions (
  application_id TEXT PRIMARY KEY REFERENCES publication_description_release_authorizations(application_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES publication_tasks(id) ON DELETE RESTRICT,
  permit_id TEXT NOT NULL UNIQUE CHECK(permit_id ~ '^pubdescpermit_[a-f0-9]{32}$'),
  proof JSONB NOT NULL CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION guard_publication_description_release_admission() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR EXISTS(SELECT 1 FROM publication_commits WHERE task_id=NEW.task_id)
    OR EXISTS(SELECT 1 FROM publication_delegated_plans WHERE task_id=NEW.task_id)
  THEN RAISE EXCEPTION 'Derived release admission does not match a retained permit' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_description_release_admission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON publication_description_release_admissions
  FOR EACH ROW EXECUTE FUNCTION guard_publication_description_release_admission();
