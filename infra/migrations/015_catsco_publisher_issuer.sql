-- No automatic historical backfill: a UID alone does not prove its issuer.
ALTER TABLE publisher_profiles ADD COLUMN catsco_issuer TEXT;
ALTER TABLE publisher_profiles ADD CONSTRAINT publisher_catsco_issuer_identity
  CHECK (catsco_issuer IS NULL OR
    (catsco_uid IS NOT NULL AND length(catsco_uid) > 0 AND
     length(catsco_issuer) BETWEEN 1 AND 2048 AND catsco_issuer ~ '^https?://'));

-- Older binaries and generic profile upserts must not silently reassign an
-- already bound identity. A future historical backfill requires a separate,
-- evidence-backed migration; ordinary profile sync never fills legacy NULLs.
CREATE FUNCTION guard_catsco_publisher_issuer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.catsco_issuer IS NOT NULL AND
    (NEW.catsco_issuer IS DISTINCT FROM OLD.catsco_issuer OR
     NEW.catsco_uid IS DISTINCT FROM OLD.catsco_uid OR
     NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'CatsCo publisher identity binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publisher_catsco_issuer_immutable
  BEFORE UPDATE ON publisher_profiles
  FOR EACH ROW EXECUTE FUNCTION guard_catsco_publisher_issuer();
