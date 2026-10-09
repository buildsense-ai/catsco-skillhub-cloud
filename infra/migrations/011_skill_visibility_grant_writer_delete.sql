-- Existing installations already applied migration 010. Make the same
-- account-deletion policy effective for those databases as well.
ALTER TABLE skill_visibility_grants
  ALTER COLUMN granted_by_user_id DROP NOT NULL;

ALTER TABLE skill_visibility_grants
  DROP CONSTRAINT IF EXISTS skill_visibility_grants_granted_by_user_id_fkey;

ALTER TABLE skill_visibility_grants
  ADD CONSTRAINT skill_visibility_grants_granted_by_user_id_fkey
  FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
