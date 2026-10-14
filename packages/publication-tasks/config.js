import { effectiveLimits } from '../publish-validation/index.js';

export function publicationTaskSettings(config) {
  const settings = config.publicationTasks;
  if (config.publicationPublishing?.enabled && !settings?.enabled) {
    throw new Error('Publication publishing requires publication tasks');
  }
  if (!settings?.enabled) return null;
  for (const [key, value] of Object.entries(settings)) {
    if (key !== 'enabled' && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid task budget');
  }
  const execution = config.publishValidation;
  for (const key of ['maxConcurrent', 'requestsPerMinute', 'readTimeoutMs', 'workerTimeoutMs', 'workerMemoryMb']) {
    if (!Number.isSafeInteger(execution[key]) || execution[key] <= 0) throw new Error('Invalid validation budget');
  }
  if (settings.leaseMs <= execution.workerTimeoutMs + 5000 || settings.retentionMs <= settings.candidateTtlMs) {
    throw new Error('Invalid task lifecycle budget');
  }
  return { ...settings, execution, limits: effectiveLimits({ ...config.limits, ...execution.limits }) };
}
