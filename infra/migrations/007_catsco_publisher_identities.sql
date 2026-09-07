ALTER TABLE publisher_profiles
  ADD COLUMN IF NOT EXISTS catsco_uid text;

WITH unique_legacy_identities AS (
  SELECT profile.contact
  FROM publisher_profiles AS profile
  JOIN users AS account ON account.id = profile.user_id
  WHERE profile.contact ~ '^catsco:[^[:space:]]+$'
    AND account.email = 'catsco-' || substr(profile.contact, 8) || '@catsco.local'
  GROUP BY profile.contact
  HAVING count(*) = 1
)
UPDATE publisher_profiles AS profile
SET catsco_uid = substr(profile.contact, 8)
FROM unique_legacy_identities AS identity
WHERE profile.contact = identity.contact
  AND profile.catsco_uid IS NULL;

-- Legacy CatsCo identities used synthetic emails with local passwords. Rotate
-- those credentials and sessions while establishing the verified UID binding,
-- so a historically preclaimed address cannot retain access to the publisher.
UPDATE users
SET password_hash = 'catsco-external-auth-only',
    updated_at = now()
WHERE id IN (
  SELECT user_id
  FROM publisher_profiles
  WHERE catsco_uid IS NOT NULL
);

UPDATE sessions
SET revoked_at = now()
WHERE revoked_at IS NULL
  AND user_id IN (
    SELECT user_id
    FROM publisher_profiles
    WHERE catsco_uid IS NOT NULL
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_publisher_profiles_catsco_uid
  ON publisher_profiles(catsco_uid)
  WHERE catsco_uid IS NOT NULL;
