import fs from 'node:fs/promises';
import path from 'node:path';
import { createStore } from '../database/store.js';
import { sha256 } from '../domain/index.js';
import { canonicalJson } from '../signing/index.js';
import { commitGitVersion, assertGitVersion } from '../git-storage/index.js';
import { buildPublishedPackage } from '../packager/index.js';
import { runPublishValidation } from '../publish-validation/runner.js';
import { runPreparePublication } from './prepare.js';
import { publicationTaskSettings } from './config.js';

export async function processPublicationCommit(config,dependencies={}) {
  if (!config.publicationPublishing?.enabled) return null;
  let settings;
  try { settings=publicationTaskSettings(config); } catch { return null; }
  if (!settings) return null;
  const store=dependencies.store ?? createStore(config);
  const task=await store.claimPublicationCommit(settings);
  if (!task) return null;
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),settings.commitTimeoutMs);
  let alive=true,pending=null;
  const heartbeat=setInterval(()=>{
    if (pending) return;
    pending=store.renewPublicationCommit(task,settings).then(ok=>{if (!ok) {alive=false;controller.abort();}},()=>{alive=false;controller.abort();}).finally(()=>{pending=null;});
  },Math.max(100,Math.floor(settings.leaseMs/3)));
  const fence=()=>{
    if (!alive) throw Object.assign(new Error('Lease lost'),{code:'skillhub.publication_task_lease_lost'});
    if (controller.signal.aborted) throw new Error('Publication deadline exceeded');
  };
  try {
    const intent=task.intent, identity=intent.identity;
    const prepared=await runPreparePublication({rawJson:task.candidate,candidateHash:task.candidate_hash,
      requestHash:task.request_hash,manifest:intent.manifest,identity},settings.limits,{
      timeoutMs:settings.execution.workerTimeoutMs,memoryMb:settings.execution.workerMemoryMb,signal:controller.signal});
    if (prepared.status!==200) {
      await store.failPublicationCommit(task,{errorCode:'skillhub.publication_task_final_validation_failed',result:prepared,retry:prepared.status>=500});
      return {taskId:task.id};
    }
    fence();
    const {manifest,files,receipt}=prepared.prepared;
    await store.beginPublicationCommit(task,receipt,{status:prepared.status,body:prepared.body});
    await store.adoptPublicVersion({uploadId:identity.uploadId,ownerId:identity.ownerId,skillId:identity.skillId,version:identity.version});
    // Repeated/stale workers can write only identical immutable material. Lease
    // fencing protects checkpoints/catalogue state, not in-flight file IO.
    const gitFiles=[...files,{path:'skill.json',content:canonicalJson(manifest)+'\n'}];
    const sourceVersion=await commitGitVersion({config,scope:'public',skillId:identity.skillId,
      version:identity.version,files:gitFiles,createdAt:identity.releaseAt,
      metadata:{uploadId:identity.uploadId,materialHash:receipt.materialHash},signal:controller.signal});
    await assertGitVersion({config,scope:'public',skillId:identity.skillId,...sourceVersion,signal:controller.signal});
    await dependencies.afterGit?.(task,sourceVersion);
    fence();
    const submission={id:identity.uploadId,submitterId:identity.ownerId,normalizedManifest:manifest};
    let checkpoint=intent.checkpoint;
    if (!checkpoint) {
      const scan=await runPublishValidation({files:gitFiles,manifest},config.limits,{
        workerUrl:new URL('./scan-worker.js',import.meta.url),timeoutMs:settings.execution.workerTimeoutMs,
        memoryMb:settings.execution.workerMemoryMb,signal:controller.signal});
      if (scan.status!==200) throw new Error('Advisory scanner unavailable');
      const report=scan.report;
      const scanRun={id:intent.scan_id,skillId:identity.skillId,version:identity.version,uploadId:identity.uploadId,
        ...report,scannerVersion:'0.1.0',startedAt:identity.releaseAt,finishedAt:identity.releaseAt};
      const packageVersion=await buildPublishedPackage({config,submission,files,scanRun,
        reviewer:{id:identity.ownerId},sourceVersion,releaseAt:identity.releaseAt,preparedPublication:receipt});
      Object.assign(packageVersion,{id:intent.package_id,riskLevel:scanRun.riskLevel,scanSummary:scanRun.summary,findings:scanRun.findings});
      await dependencies.afterArtifact?.(task,packageVersion);
      fence();
      checkpoint=await store.checkpointPublicationCommit(task,{packageVersion,scanRun});
    }
    const p=checkpoint.packageVersion;
    if (p.gitCommitSha!==sourceVersion.commitSha || p.gitTreeSha!==sourceVersion.treeSha || p.gitTag!==sourceVersion.tag ||
      p.artifactSha256!==p.checksumSha256 || !/^[a-f0-9]{64}$/.test(p.artifactSha256)) throw new Error('Invalid checkpoint');
    const artifactPath=path.join(config.paths.artifacts,p.artifactSha256.slice(0,2),`${p.artifactSha256}.skillpkg`);
    if (path.resolve(p.packagePath)!==path.resolve(artifactPath) || (await fs.stat(artifactPath)).size!==p.packageSize) throw new Error('Artifact unavailable');
    const bytes=await fs.readFile(artifactPath);
    if (sha256(bytes)!==p.checksumSha256) throw new Error('Artifact changed');
    const artifact=JSON.parse(bytes.toString('utf8'));
    if (canonicalJson(artifact.payload.manifest)!==canonicalJson(manifest) ||
      canonicalJson(artifact.payload.files)!==canonicalJson(files)) throw new Error('Artifact material changed');
    await dependencies.beforeComplete?.(task,checkpoint);
    fence();
    await store.createPackageVersion(p,submission,{publicationTask:task});
  } catch (error) {
    const codes=['owner_inactive','publisher_changed','prepared_changed','lease_lost'].map(s=>`skillhub.publication_task_${s}`);
    await store.failPublicationCommit(task,{errorCode:codes.includes(error.code)?error.code:'skillhub.publication_task_publish_unavailable',
      retry:!codes.includes(error.code)});
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    if (pending) await pending;
  }
  return {taskId:task.id};
}
