-- Keep the isolated derived-release state machine coherent while its worker
-- advances from preparation to Git/package completion. This trigger does not
-- authorize publication; the permit/admission binding remains in migration
-- 024 and final authority is rechecked by the completion store.
CREATE FUNCTION guard_publication_description_release_commit_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Description release commit is retained' USING ERRCODE='23514';
  END IF;
  IF NEW.state='queued' THEN
    IF NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
      OR NEW.receipt IS NOT NULL OR NEW.checkpoint IS NOT NULL OR NEW.publication_result IS NOT NULL
    THEN RAISE EXCEPTION 'Queued description release commit has completion state' USING ERRCODE='23514'; END IF;
  ELSIF NEW.state='publishing' THEN
    IF NEW.lease_token IS NULL OR NEW.lease_until IS NULL
      OR NEW.receipt IS NOT NULL OR NEW.checkpoint IS NOT NULL OR NEW.publication_result IS NOT NULL
    THEN RAISE EXCEPTION 'Publishing description release commit lease/state mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NEW.state='committing' THEN
    IF NEW.receipt IS NULL OR jsonb_typeof(NEW.receipt) IS DISTINCT FROM 'object'
      OR NEW.publication_result IS NOT NULL
      OR (NEW.lease_token IS NULL) IS DISTINCT FROM (NEW.lease_until IS NULL)
    THEN RAISE EXCEPTION 'Committing description release commit evidence/state mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NEW.state='published' THEN
    IF NEW.receipt IS NULL OR NEW.checkpoint IS NULL OR NEW.publication_result IS NULL
      OR jsonb_typeof(NEW.receipt) IS DISTINCT FROM 'object'
      OR jsonb_typeof(NEW.checkpoint) IS DISTINCT FROM 'object'
      OR jsonb_typeof(NEW.publication_result) IS DISTINCT FROM 'object'
      OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.error_code IS NOT NULL
    THEN RAISE EXCEPTION 'Published description release commit is incomplete' USING ERRCODE='23514'; END IF;
  ELSIF NEW.state='publish_failed' THEN
    IF NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.error_code IS NULL
    THEN RAISE EXCEPTION 'Failed description release commit has active lease' USING ERRCODE='23514'; END IF;
  ELSE
    RAISE EXCEPTION 'Unknown description release commit state' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_description_release_commit_lifecycle_guard
  BEFORE INSERT OR UPDATE OR DELETE ON publication_description_release_commits
  FOR EACH ROW EXECUTE FUNCTION guard_publication_description_release_commit_lifecycle();
