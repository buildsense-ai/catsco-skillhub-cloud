import { parentPort, workerData } from 'node:worker_threads';
import { scanSkillPackage } from '../scanner/index.js';

// The advisory scanner reads attacker-controlled script/text content too. Keep
// its regex/decoding work within the same isolated CPU/memory/abort budget.
try {
  const {files,manifest}=workerData.rawJson;
  const report=scanSkillPackage({files:files.map(file=>({path:file.path,
    buffer:file.contentBase64!==undefined?Buffer.from(file.contentBase64,'base64'):Buffer.from(file.content)})),
    manifest,config:{limits:workerData.limits}});
  parentPort.postMessage({status:200,report});
} catch {parentPort.postMessage({status:503});}
