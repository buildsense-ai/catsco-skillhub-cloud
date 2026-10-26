import { PublicationDescriptionDerivationError } from './store.js';
import { canonicalJson } from '../signing/index.js';

const app = value => typeof value === 'string' && /^pubdesc_[a-f0-9]{64}$/.test(value);
const permit = value => typeof value === 'string' && /^pubdescpermit_[a-f0-9]{32}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export class PublicationDescriptionCommitAdmissionError extends Error {
  constructor(kind = 'unavailable') {
    super('Description release commit admission could not be completed.');
    this.code = `skillhub.publication_description_release_commit_${kind}`;
  }
}

const fail = kind => { throw new PublicationDescriptionCommitAdmissionError(kind); };

function validRequest(input) {
  return exact(input, ['schemaVersion', 'applicationId', 'permitId']) && input.schemaVersion === 1
    && app(input.applicationId) && permit(input.permitId);
}

// Persist an isolated commit admission. It intentionally does not enqueue a
// publication job or touch legacy publication_commits; a later worker slice
// will claim this row and publish only the retained derived bytes.
export function createPublicationDescriptionCommitAdmission({ enabled = false, store } = {}) {
  if (enabled !== true || !store?.tx || !store?.query) return Object.freeze({
    async admit() { fail('disabled'); }
  });
  return Object.freeze({
    async admit(input) {
      if (!validRequest(input)) fail('invalid');
      try {
        return await store.tx(async client => {
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query("SET LOCAL statement_timeout='10s'");
          const row = (await client.query(`SELECT p.application_id,p.task_id,p.target,p.manifest,p.identity,
              a.permit_id,a.proof,d.derived_candidate_hash,t.authority_kind
            FROM publication_description_release_plans p
            JOIN publication_description_release_admissions a USING(application_id,task_id)
            JOIN publication_description_derivations d USING(application_id)
            JOIN publication_tasks t ON t.id=p.task_id
            WHERE p.application_id=$1 AND a.permit_id=$2 AND a.proof->>'applicationId'=$1
              AND t.authority_kind='catsco'`, [input.applicationId, input.permitId])).rows[0];
          if (!row || row.target.candidateHash !== row.derived_candidate_hash) fail('conflict');
          const existing = (await client.query(`SELECT application_id,task_id,permit_id,target,manifest,identity,state
            FROM publication_description_release_commits WHERE application_id=$1`, [input.applicationId])).rows[0];
          if (existing) {
            if (existing.permit_id !== input.permitId || canonicalJson(existing.target) !== canonicalJson(row.target)
              || canonicalJson(existing.manifest) !== canonicalJson(row.manifest)
              || canonicalJson(existing.identity) !== canonicalJson(row.identity)) fail('conflict');
            return { ...existing, replayed: true };
          }
          const inserted = await client.query(`INSERT INTO publication_description_release_commits
            (application_id,task_id,permit_id,target,manifest,identity,state)
            VALUES($1,$2,$3,$4,$5,$6,'queued')
            RETURNING application_id,task_id,permit_id,target,manifest,identity,state`,
          [row.application_id,row.task_id,row.permit_id,JSON.stringify(row.target),JSON.stringify(row.manifest),JSON.stringify(row.identity)]);
          return { ...inserted.rows[0], replayed: false };
        });
      } catch (error) {
        if (error instanceof PublicationDescriptionCommitAdmissionError) throw error;
        throw new PublicationDescriptionCommitAdmissionError('unavailable');
      }
    }
  });
}

export { validRequest };
