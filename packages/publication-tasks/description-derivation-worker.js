import { parentPort, workerData } from 'node:worker_threads';
import { derivePublicationDescription } from './description-derivation.js';

try {
  parentPort.postMessage(derivePublicationDescription(workerData.rawJson, workerData.limits));
} catch {
  parentPort.postMessage({ status: 503, body: { error: {
    code: 'skillhub.publication_description_derivation_unavailable',
    message: 'Description candidate derivation could not complete. Please retry.'
  } } });
}
