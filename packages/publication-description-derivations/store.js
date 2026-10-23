import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^pubdesc_[a-f0-9]{64}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const proposalDigest = proposal => createHash('sha256').update(`skillhub-description-derivation-v1:proposal\0${canonical(proposal)}`).digest('hex');

export class PublicationDescriptionDerivationError extends Error {
  constructor(code, status = 409) {
    super('Description derivation could not be retained.');
    this.code = `skillhub.publication_description_derivation_${code}`;
    this.status = status;
  }
}

function exactProposal(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 4
    && Object.hasOwn(value, 'relativePath') && Object.hasOwn(value, 'field')
    && Object.hasOwn(value, 'entryIndex') && Object.hasOwn(value, 'text')
    && value.relativePath === 'SKILL.md' && value.field === 'description'
    && Number.isSafeInteger(value.entryIndex) && value.entryIndex >= 0
    && typeof value.text === 'string' && value.text.isWellFormed()
    && value.text.trim().length > 0 && Buffer.byteLength(value.text) <= 8192
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text);
}

export function createPublicationDescriptionDerivationStore({ query, tx }) {
  const read = async (client, applicationId) => (await client.query(`
    SELECT application_id,task_id,request_hash,candidate_hash,proposal,proposal_digest,
      derived_request_hash,derived_candidate_hash,derived_raw_json,derived_bytes,derivation_receipt,created_at
    FROM publication_description_derivations WHERE application_id=$1`, [applicationId])).rows[0] ?? null;

  return {
    async getSource(taskId) {
      if (!/^pubtask_[0-9a-f-]{36}$/.test(taskId)) return null;
      const result = await query(`SELECT id,authority_kind,request_hash,candidate_hash,candidate,
        candidate_bytes,intake_result,validation_result,state,expires_at
        FROM publication_tasks WHERE id=$1 AND authority_kind='catsco'`, [taskId]);
      return result.rows[0] ?? null;
    },
    async retainPublicationDescriptionDerivation({ applicationId, taskId, proposal, derived }) {
      if (!id(applicationId) || !/^pubtask_[0-9a-f-]{36}$/.test(taskId) || !exactProposal(proposal)
        || !derived || typeof derived.rawJson !== 'string' || !derived.receipt
        || !digest(derived.receipt.originalRequestHash) || !digest(derived.receipt.originalCandidateHash)
        || !digest(derived.receipt.proposalDigest) || !digest(derived.receipt.derivedRequestHash)
        || !digest(derived.receipt.derivedCandidateHash)) {
        throw new PublicationDescriptionDerivationError('invalid', 400);
      }
      const bytes = Buffer.from(derived.rawJson);
      const proposalDigest = derived.receipt.proposalDigest;
      const row = await tx(async client => {
        const existing = await read(client, applicationId);
        if (existing) {
          if (existing.task_id !== taskId || existing.request_hash !== derived.receipt.originalRequestHash
            || existing.candidate_hash !== derived.receipt.originalCandidateHash
            || existing.proposal_digest !== proposalDigest
            || existing.derived_candidate_hash !== derived.receipt.derivedCandidateHash) {
            throw new PublicationDescriptionDerivationError('conflict');
          }
          return existing;
        }
        const inserted = await client.query(`INSERT INTO publication_description_derivations
          (application_id,task_id,request_hash,candidate_hash,proposal,proposal_digest,
           derived_request_hash,derived_candidate_hash,derived_raw_json,derived_bytes,derivation_receipt)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING
           application_id,task_id,request_hash,candidate_hash,proposal,proposal_digest,
           derived_request_hash,derived_candidate_hash,derived_raw_json,derived_bytes,derivation_receipt,created_at`,
          [applicationId, taskId, derived.receipt.originalRequestHash, derived.receipt.originalCandidateHash,
            JSON.stringify(proposal), proposalDigest, derived.receipt.derivedRequestHash,
            derived.receipt.derivedCandidateHash, bytes, bytes.length, JSON.stringify(derived.receipt)]);
        return inserted.rows[0];
      });
      return row;
    },
    async getPublicationDescriptionDerivation(applicationId) {
      if (!id(applicationId)) return null;
      return query(`SELECT application_id,task_id,request_hash,candidate_hash,proposal,proposal_digest,
        derived_request_hash,derived_candidate_hash,derived_raw_json,derived_bytes,derivation_receipt,created_at
        FROM publication_description_derivations WHERE application_id=$1`, [applicationId]).then(r => r.rows[0] ?? null);
    },
    async getPublicationDescriptionDerivationSource(taskId) {
      if (!/^pubtask_[0-9a-f-]{36}$/.test(taskId)) return null;
      const result = await query(`SELECT id,authority_kind,request_hash,candidate_hash,candidate,
        candidate_bytes,intake_result,validation_result,state,expires_at
        FROM publication_tasks WHERE id=$1 AND authority_kind='catsco'`, [taskId]);
      return result.rows[0] ?? null;
    }
  };
}

export { exactProposal, proposalDigest };
