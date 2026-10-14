import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { normalizeManifest, slugify } from '../domain/index.js';
import { validatePublishRequest, parseStrictJson, readEntryFrontmatter, effectiveLimits } from '../publish-validation/index.js';
import { decodeSource } from '../publish-validation/intake.js';
import { preparePublication } from './prepare.js';

try {
  const { candidate, requestHash, candidateHash, namespace } = workerData.rawJson;
  const limits = effectiveLimits(workerData.limits);
  if (createHash('sha256').update(candidate).digest('hex') !== requestHash) throw new Error();
  const raw = new TextDecoder('utf-8',{ fatal:true }).decode(candidate);
  const result = validatePublishRequest(raw,limits);
  if (result.status !== 200) parentPort.postMessage(result);
  else if (result.body.validation.candidateHash !== candidateHash) throw new Error();
  else {
    const body = parseStrictJson(raw,limits), files = decodeSource(body,limits);
    const root = files.find(f=>f.path==='skill.json');
    const packaged = root ? parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(root.buffer),limits) : {};
    const explicit = body.manifest ?? body.form ?? {};
    const entry = explicit.entrypoints?.skillFile ?? explicit.skillFile ?? packaged.entrypoints?.skillFile ?? packaged.skillFile ?? 'SKILL.md';
    const fm = readEntryFrontmatter(files.find(f=>f.path===entry),limits).data;
    const merged = { ...packaged,...explicit };
    const manifest = normalizeManifest({ ...merged,name:merged.name ?? fm.name,
      description:merged.description ?? fm.description,entrypoints:{skillFile:entry} });
    manifest.id = `${slugify(namespace,'user')}/${manifest.name}`;
    manifest.author.name = slugify(namespace,'user');
    // Bound private intent metadata independently from candidate-file budgets.
    if (Buffer.byteLength(JSON.stringify(manifest)) > 32768) throw new Error();
    // Run the same side-effect-free preparation before allocating a permanent
    // version. This preview identity is internal only: discard its material and
    // receipt. The commit worker MUST prepare again with the reserved identity.
    const preview = preparePublication({rawJson:candidate,requestHash,candidateHash,manifest,
      identity:{ownerId:'preflight',uploadId:'preflight',skillId:manifest.id,
        version:manifest.version,releaseAt:'2000-01-01T00:00:00.000Z'}},limits);
    parentPort.postMessage(preview.status === 200 ? {status:200,manifest}
      : {status:preview.status,body:preview.body});
  }
} catch {
  parentPort.postMessage({ status:422,body:{error:{code:'skillhub.publication_task_manifest_invalid',
    message:'Publication metadata could not be derived safely; review the candidate.'}} });
}
