import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { normalizeManifest, slugify } from '../domain/index.js';
import { validatePublishRequest, parseStrictJson, readEntryFrontmatter, effectiveLimits } from '../publish-validation/index.js';
import { decodeSource } from '../publish-validation/intake.js';

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
    parentPort.postMessage({ status:200,manifest });
  }
} catch {
  parentPort.postMessage({ status:422,body:{error:{code:'skillhub.publication_task_manifest_invalid',
    message:'Publication metadata could not be derived safely; review the candidate.'}} });
}
