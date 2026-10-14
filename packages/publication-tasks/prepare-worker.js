import { parentPort, workerData } from 'node:worker_threads';
import { preparePublication } from './prepare.js';

try {
  parentPort.postMessage(preparePublication(workerData.rawJson, workerData.limits));
} catch {
  parentPort.postMessage({ status: 503, body: { error: {
    code: 'skillhub.publication_prepare_unavailable',
    message: 'Publication preparation could not complete. Please retry.'
  } } });
}
