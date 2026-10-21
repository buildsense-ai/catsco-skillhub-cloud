import {timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {RateLimiter} from '../../packages/auth/index.js';
import {parseStrictJson} from '../../packages/publish-validation/index.js';
import {validReceiptPeerConfig,validPublicationReceipt} from '../../packages/publication-delegation/receipt-client.js';
import {createPublicationCommitPermitClient,PublicationCommitPermitError} from '../../packages/publication-delegation/commit-permit-client.js';
import {createDelegatedPublicationCommitCoordinator,DelegatedCommitError} from '../../packages/publication-delegation/commit-coordinator.js';
import {readRaw,withAbort} from './publish-validation.js';

export const PUBLICATION_COMMIT_PATH='/api/skills/publication-delegations/commit';
const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) &&
  Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
function header(req,name){
  const values=[];
  for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)values.push(req.rawHeaders[i+1]);
  if(values.length>1)throw Error('duplicate header');return values[0];
}

// Service-only. CatsCo authenticates the original human before plan/status,
// then records exact trusted human intent before authorize. This handler never
// records that intent, accepts a caller target, or falls back to account auth.
export function createPublicationCommitHandler(config,store,dependencies={}){
  const settings=config.publicationCommitService??{},enabled=settings.enabled===true;
  const limiter=new RateLimiter({limit:60,windowMs:60000,maxBuckets:1});
  const budget=dependencies.timeoutMs??20000;
  let coordinator,secret,hosts,proxies;
  try{
    if(enabled){
      if(!validReceiptPeerConfig(settings) || !Number.isInteger(budget) || budget<1 || budget>20000 ||
        !Array.isArray(settings.trustedProxyAddresses)||settings.trustedProxyAddresses.some(ip=>!isIP(ip)) ||
        [config.agent?.clientSecret,config.session?.secret,config.mutationWriter?.secret].includes(settings.peerSecret))throw Error();
      const audience=new URL(settings.audience);
      hosts=new Set([audience.host,...(!audience.port?[audience.hostname+':443']:[])]);
      secret=Buffer.from('Bearer '+settings.peerSecret);proxies=new Set(settings.trustedProxyAddresses);
      coordinator=dependencies.coordinator??createDelegatedPublicationCommitCoordinator({...settings,config,store,
        permitClient:createPublicationCommitPermitClient(settings)});
    }
  }catch{coordinator=null;}
  let active=0;
  return async(req,res)=>{
    // The existing control handler reserves the rest of this namespace.
    if(!req.url?.startsWith(PUBLICATION_COMMIT_PATH))return false;
    const reply=(status,body)=>{
      if(res.destroyed||res.writableEnded)return;
      if(!req.complete)res.setHeader('Connection','close');
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify(body));
    };
    const fail=(status,kind)=>reply(status,{error:{code:'skillhub.delegated_commit_'+kind,message:'Delegated publication request could not be completed.'}});
    if(!enabled || req.url!==PUBLICATION_COMMIT_PATH){fail(404,'disabled');return true;}
    if(!coordinator){fail(503,'configuration');return true;}
    if(req.method!=='POST'){fail(405,'invalid');return true;}
    try{
      const proxy=proxies.has(req.socket.remoteAddress)&&header(req,'x-forwarded-proto')==='https';
      if((!req.socket.encrypted&&!proxy)||!hosts.has(header(req,'host'))||header(req,'origin')!==undefined||header(req,'cookie')!==undefined)throw Error();
      const supplied=Buffer.from(header(req,'authorization')??'');
      if(supplied.length!==secret.length||!timingSafeEqual(supplied,secret))throw Error();
    }catch{fail(401,'unauthorized');return true;}
    if(!limiter.check('catsco-peer')){fail(429,'busy');return true;}
    if(active>=4){fail(503,'busy');return true;}
    active++;
    const controller=new AbortController(),abort=()=>controller.abort();
    req.once('aborted',abort);res.once('close',abort);const timer=setTimeout(abort,budget);
    const work=(async()=>{
      const length=header(req,'content-length');
      if(header(req,'content-encoding')!==undefined||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(header(req,'content-type')??'')||
        (length!==undefined&&(!/^[1-9][0-9]{0,3}$/.test(length)||Number(length)>4096)))throw new DelegatedCommitError('invalid');
      let input;
      try{input=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(await readRaw(req,4096,controller.signal)),{maxDepth:5,maxNodes:80});}
      catch{throw new DelegatedCommitError(controller.signal.aborted?'unavailable':'invalid');}
      const keys=['schemaVersion','action','receipt',...(input?.action==='plan'?['confirmVersionPublish']:[])];
      if(!exact(input,keys)||input.schemaVersion!==1||!['plan','authorize','read','report'].includes(input.action)||
        !validPublicationReceipt(input.receipt)||(input.action==='plan'&&typeof input.confirmVersionPublish!=='boolean'))throw new DelegatedCommitError('invalid');
      if(controller.signal.aborted)throw new DelegatedCommitError('unavailable');
      if(input.action==='plan')return coordinator.prepare(input.receipt,{confirmVersionPublish:input.confirmVersionPublish,signal:controller.signal});
      if(input.action==='read')return coordinator.read(input.receipt);
      if(input.action==='report')return coordinator.report(input.receipt);
      const result=await coordinator.authorize(input.receipt,{signal:controller.signal});
      return {schemaVersion:1,receipt:input.receipt,state:result.state,permitId:result.permitId};
    })();
    work.then(()=>{active--;},()=>{active--;});
    try{reply(200,await withAbort(work,controller.signal));}
    catch(error){
      let kind='unavailable';
      if(error instanceof DelegatedCommitError)kind=error.code.replace('skillhub.delegated_commit_','');
      if(error instanceof PublicationCommitPermitError)kind=({denied:'publisher_changed',cancelled:'cancelled',conflict:'conflict',busy:'busy'})[error.code.replace('skillhub.publication_commit_permit_','')]??'unavailable';
      fail(({invalid:400,not_found:404,conflict:409,cancelled:409,publisher_changed:403,confirmation_required:409,rejected:422,storage_limit:429})[kind]??503,kind);
    }finally{clearTimeout(timer);req.off('aborted',abort);res.off('close',abort);}
    return true;
  };
}
