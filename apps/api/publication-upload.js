import {isIP} from 'node:net';
import {RateLimiter} from '../../packages/auth/index.js';
import {publicationTaskSettings} from '../../packages/publication-tasks/config.js';
import {createPublicationIntrospectionClient,PublicationAuthorityError} from '../../packages/publication-delegation/introspection.js';
import {validReceiptPeerConfig} from '../../packages/publication-delegation/receipt-client.js';
import {createDelegatedPublicationIntake} from '../../packages/publication-delegation/intake.js';
import {readRaw,withAbort} from './publish-validation.js';

export const PUBLICATION_UPLOAD_PATH='/api/skills/publication-delegations/candidates';
const match=(v,re)=>typeof v==='string' && v.match(re)?.[0]===v;
function header(req,name){
  const values=[];
  for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)values.push(req.rawHeaders[i+1]);
  if(values.length>1)throw Error('duplicate header');return values[0];
}
const error=(status,kind)=>Object.assign(Error('Publication candidate upload could not complete.'),{status,uploadKind:kind});

// Runtime-only upload grant, NOT the service credential or a human session.
// The server credential remains inside the pinned introspection client.
export function createPublicationUploadHandler(config,store,dependencies={}){
  const settings=config.publicationUpload??{},enabled=settings.enabled===true;
  let accept,peer,hosts,proxies,limit,slots,readBudget;
  const budget=dependencies.timeoutMs??60000;
  const globalLimit=new RateLimiter({limit:60,windowMs:60000,maxBuckets:1});
  const ipLimit=new RateLimiter({limit:30,windowMs:60000,maxBuckets:2000});
  const actorLimit=new RateLimiter({limit:10,windowMs:60000,maxBuckets:20000});
  try{
    if(enabled){
      const task=publicationTaskSettings(config);
      if(!task || !validReceiptPeerConfig(settings) || !Number.isSafeInteger(budget) || budget<1 || budget>60000 ||
        !Array.isArray(settings.trustedProxyAddresses)||settings.trustedProxyAddresses.some(ip=>!isIP(ip)) ||
        [config.agent?.clientSecret,config.session?.secret,config.mutationWriter?.secret].includes(settings.peerSecret))throw Error();
      const origin=new URL(settings.audience);
      hosts=new Set([origin.host,...(!origin.port?[origin.hostname+':443']:[])]);
      proxies=new Set(settings.trustedProxyAddresses);
      limit=Math.min(task.limits.maxRequestBytes,32*1024*1024);
      slots=Math.min(task.execution.maxConcurrent,4);readBudget=Math.min(task.execution.readTimeoutMs,10000,budget);
      peer=dependencies.introspectionClient??createPublicationIntrospectionClient(settings);
      accept=dependencies.accept??createDelegatedPublicationIntake({enabled:true,config,store,
        introspectionClient:peer,issuer:settings.issuer,audience:settings.audience});
    }
  }catch{accept=null;}
  let active=0;
  return async(req,res)=>{
    if(!req.url?.startsWith(PUBLICATION_UPLOAD_PATH))return false;
    const reply=(status,body)=>{
      if(res.destroyed||res.writableEnded)return;
      if(!req.complete)res.setHeader('Connection','close');
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify(body));
    };
    const fail=(status,kind)=>reply(status,{schemaVersion:1,accepted:false,error:{
      code:'skillhub.publication_upload_'+kind,message:'Publication candidate upload could not complete.'}});
    if(!enabled||req.url!==PUBLICATION_UPLOAD_PATH){fail(404,'disabled');return true;}
    if(!accept){fail(503,'configuration');return true;}
    if(req.method!=='POST'){fail(405,'invalid');return true;}
    let token,entryRequestId,authorityEpoch,sourceSnapshotHash,idempotencyKey,length;
    try{
      const proxy=proxies.has(req.socket.remoteAddress)&&header(req,'x-forwarded-proto')==='https';
      if((!req.socket.encrypted&&!proxy)||!hosts.has(header(req,'host'))||header(req,'origin')!==undefined||header(req,'cookie')!==undefined)throw Error();
      const auth=header(req,'authorization');
      if(!match(auth,/^Bearer pubupload_[a-f0-9]{64}$/))throw Error();
      token=auth.slice(7);
    }catch{fail(401,'unauthorized');return true;}
    try{
      entryRequestId=header(req,'x-publication-entry');
      const epoch=header(req,'x-publication-epoch');
      sourceSnapshotHash=header(req,'x-publication-source-hash');idempotencyKey=header(req,'idempotency-key');
      length=header(req,'content-length');
      if(!match(entryRequestId,/^pubentry_[a-f0-9]{32}$/)||!match(epoch,/^[1-8]$/)||
        !match(sourceSnapshotHash,/^[a-f0-9]{64}$/)||!match(idempotencyKey,/^pubcandidate_[a-f0-9]{32}$/)||
        header(req,'content-encoding')!==undefined||header(req,'transfer-encoding')!==undefined||
        !match(header(req,'content-type'),/^application\/json(?:;\s*charset=utf-8)?$/i)||
        !match(length,/^[1-9][0-9]{0,8}$/))throw Error();
      authorityEpoch=Number(epoch);
    }catch{fail(400,'invalid');return true;}
    if(Number(length)>limit){fail(413,'too_large');return true;}
    // No untrusted forwarded IP, UID, entry, or rotating token as rate-limit key.
    if(!globalLimit.check('upload')||!ipLimit.check(req.socket.remoteAddress??'unknown')){fail(429,'busy');return true;}
    if(active>=slots){fail(503,'busy');return true;}
    active++;
    const controller=new AbortController(),abort=()=>controller.abort();
    req.once('aborted',abort);res.once('close',abort);
    const timer=setTimeout(abort,budget),readTimer=setTimeout(abort,readBudget);
    const work=(async()=>{
      const rawBody=await readRaw(req,limit,controller.signal);clearTimeout(readTimer);
      if(rawBody.length!==Number(length))throw error(400,'invalid');
      const input={token,entryRequestId,authorityEpoch,rawBody,sourceSnapshotHash,idempotencyKey};
      // Authenticate the byte-bound grant BEFORE parsing/worker/DB maintenance.
      // Intake performs a SECOND fresh check after validation, and SQL expiry
      // checks before commit. A request-shaped bearer is not authorization.
      const grant=await peer.checkUploadGrant(input,{signal:controller.signal});
      if(controller.signal.aborted)throw error(503,'unavailable');
      if(!actorLimit.check(grant.actorCatsCoUid))throw error(429,'busy');
      const result=await accept(input,{signal:controller.signal});
      if(!result.accepted){
        // No task was admitted. Detailed repair reports are delivered through
        // the owner-private task/report protocol, never unbounded RPC output.
        throw error(result.validation?.status===413?413:422,'rejected');
      }
      const a=result.association;
      return {schemaVersion:1,accepted:true,created:result.created,association:{
        taskId:a.taskId,entryRequestId:a.entryRequestId,candidateRevision:a.candidateRevision,
        candidateHash:a.candidateHash,requestHash:a.requestHash,authorityEpoch:a.authorityEpoch,
        eventId:a.eventId,state:a.state,candidateAvailable:a.candidateAvailable}};
    })();
    // An HTTP timeout/abort is not proof the DB rolled back. Hold the slot
    // until all work settles; exact replay recovers any retained association.
    work.then(()=>{active--;},()=>{active--;});
    try{const result=await withAbort(work,controller.signal);reply(result.created?201:200,result);}
    catch(e){
      let kind='unavailable',status=503;
      if(e instanceof PublicationAuthorityError){
        const k=e.code.replace('skillhub.publication_authority_','');
        if(k==='inactive'){kind='inactive';status=403;}else if(k==='busy'){kind='busy';}
      }else if(e?.uploadKind){kind=e.uploadKind;status=e.status;}
      else{
        const mapped={
          'skillhub.publication_task_candidate_changed':[409,'candidate_changed'],
          'skillhub.publication_task_request_conflict':[409,'conflict'],
          'skillhub.publication_task_publisher_unverified':[403,'publisher_unverified'],
          'skillhub.publication_task_storage_limit':[429,'storage_limit'],
          'skillhub.publish_validation_request_too_large':[413,'too_large']
        }[e?.code];
        if(mapped)[status,kind]=mapped;
      }
      fail(status,kind);
    }finally{clearTimeout(timer);clearTimeout(readTimer);req.off('aborted',abort);res.off('close',abort);}
    return true;
  };
}
