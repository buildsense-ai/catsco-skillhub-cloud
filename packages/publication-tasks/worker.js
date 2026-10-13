import { createHash } from 'node:crypto';
import { createStore } from '../database/store.js';
import { publicationTaskSettings } from './config.js';
import { runPublishValidation } from '../publish-validation/runner.js';

export async function processPublicationTask(config, dependencies = {}) {
  let settings;
  try { settings = publicationTaskSettings(config); } catch { return null; }
  if (!settings) return null;
  const store = dependencies.store ?? createStore(config);
  const task = await store.claimPublicationTask(settings);
  if (!task) return null;
  const finish = result => store.finishPublicationTask(task, result);
  try {
    const owner = await store.getUserById(task.owner_user_id);
    if (!owner || owner.status !== 'active') {
      await finish({ errorCode: 'skillhub.publication_task_owner_inactive' });
      return { taskId: task.id };
    }
    if (!Buffer.isBuffer(task.candidate) || task.candidate.length !== Number(task.candidate_bytes) ||
      task.candidate.length > settings.limits.maxRequestBytes ||
      createHash('sha256').update(task.candidate).digest('hex') !== task.request_hash) {
      await finish({ errorCode: 'skillhub.publication_task_candidate_changed' });
      return { taskId: task.id };
    }
    const validate = dependencies.validate ?? runPublishValidation;
    const result = await validate(task.candidate, settings.limits, {
      timeoutMs: settings.execution.workerTimeoutMs, memoryMb: settings.execution.workerMemoryMb
    });
    const report = result.body.validation ?? result.body.error?.validation;
    if (result.status >= 500) await finish({ errorCode: 'skillhub.publication_task_validation_unavailable', retry: true });
    else if (result.status === 200 && report?.candidateHash !== task.candidate_hash) await finish({ errorCode: 'skillhub.publication_task_candidate_changed' });
    else await finish({ result });
  } catch {
    await finish({ errorCode: 'skillhub.publication_task_validation_unavailable', retry: true });
  }
  // Lease-fenced completion may have been discarded after cancellation/reclaim.
  // This return value is only scheduling information, never a publication result.
  return { taskId: task.id };
}
