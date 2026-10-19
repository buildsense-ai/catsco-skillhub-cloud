import https from 'node:https';
import { parseStrictJson } from '../publish-validation/index.js';
import { validPublicationReceipt, validReceiptPeerConfig } from './receipt-client.js';

export const COMMIT_PERMIT_PATH = '/api/skillhub/publications/internal/commit-permits/authorize';
const targetKeys = ['candidateHash','manifestHash','publisherUserId','publisherProfileId','namespace',
  'skillId','version','uploadId','releaseAt','confirmVersionPublish'];
const exact = (v, fields) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v,k));
const matches = (v,re) => typeof v === 'string' && v.match(re)?.[0] === v;
const hash = /^[a-f0-9]{64}$/;
const reference = /^[A-Za-z0-9._:-]{1,128}$/;
const same = (a,b) => exact(a,Object.keys(b)) && Object.keys(b).every(k=>a[k]===b[k]);

export class PublicationCommitPermitError extends Error {
  constructor(kind='unavailable') {
    const messages = {disabled:'Publication commit permit client is disabled.',
      configuration:'Publication commit permit configuration is unavailable.',
      invalid:'Publication commit intent is invalid.',busy:'Publication commit permit client is busy.',
      denied:'Publication commit authority is denied.',cancelled:'Publication intent was cancelled.',
      conflict:'Publication commit conflicts with retained intent.',unavailable:'Publication commit permit is unavailable.'};
    if (!Object.hasOwn(messages,kind)) kind='unavailable';
    super(messages[kind]);
    this.name='PublicationCommitPermitError'; this.code=`skillhub.publication_commit_permit_${kind}`;
  }
}

export function validPublicationCommitTarget(t) {
  if (!exact(t,targetKeys) || !matches(t.candidateHash,hash) || !matches(t.manifestHash,hash) ||
    ![t.publisherUserId,t.publisherProfileId,t.uploadId].every(v=>matches(v,reference)) ||
    !matches(t.skillId,/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/) || t.skillId.length>256 ||
    typeof t.namespace!=='string' || t.namespace.length>128 || !t.skillId.startsWith(t.namespace+'/') ||
    !matches(t.version,/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/) || t.version.length>160 ||
    typeof t.confirmVersionPublish!=='boolean' || !matches(t.releaseAt,/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/)) return false;
  const at = new Date(t.releaseAt);
  return Number.isFinite(at.getTime()) && at.toISOString()===t.releaseAt;
}

// Go/PG retain microseconds, unlike JS Date. Validate the date but preserve the
// original RFC3339Nano wire text for exact replay, never round it to milliseconds.
function validAuthorizedAt(v) {
  if(!matches(v,/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/))return false;
  const whole=v.slice(0,19)+'.000Z', at=new Date(whole);
  return Number.isFinite(at.getTime()) && at.toISOString()===whole && at.getUTCFullYear()>1;
}

// Native HTTPS only: no proxy env, redirects, caller URLs or upload credentials.
// Slots are held until transport close, including after abort or invalid replies.
function send(url,secret,body,signal,requestImpl) {
  return new Promise((resolve,reject)=>{
    let req,res,timer,result,failed=false;
    const fail=()=>{failed=true;res?.destroy();req?.destroy();};
    const finish=()=>{
      clearTimeout(timer);signal?.removeEventListener('abort',fail);
      if(failed||!result)reject(new PublicationCommitPermitError());else resolve(result);
    };
    if(signal?.aborted){reject(new PublicationCommitPermitError());return;}
    try {
      req=requestImpl(url,{method:'POST',agent:false,rejectUnauthorized:true,maxHeaderSize:8192,
        headers:{Authorization:`Bearer ${secret}`,Accept:'application/json','Accept-Encoding':'identity',
          'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'}},response=>{
        res=response;res.on('error',fail);res.on('aborted',fail);
        const header=name=>{
          const values=[];
          for(let i=0;i<res.rawHeaders.length;i+=2)if(res.rawHeaders[i].toLowerCase()===name)values.push(res.rawHeaders[i+1]);
          if(values.length>1)throw new Error();return values[0];
        };
        let declared,size=0;const chunks=[];
        try {
          if(![200,403,409].includes(res.statusCode)||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(header('content-type')??'')||
            header('content-encoding')!==undefined||!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(header('cache-control')??''))throw new Error();
          const length=header('content-length');
          if(length!==undefined){if(!matches(length,/^[1-9][0-9]{0,3}$/)||Number(length)>4096)throw new Error();declared=Number(length);}
        }catch{fail();return;}
        res.on('data',chunk=>{size+=chunk.length;if(size>4096){fail();return;}chunks.push(chunk);});
        res.on('end',()=>{
          if(failed)return;
          try {
            if(!res.complete||size===0||(declared!==undefined&&size!==declared))throw new Error();
            result={status:res.statusCode,text:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size))};
          }catch{fail();return;}
          req.destroy();
        });
      });
      req.on('error',fail);req.once('close',finish);
      timer=setTimeout(fail,6000);signal?.addEventListener('abort',fail,{once:true});
      if(signal?.aborted)fail();else req.end(body);
    }catch{
      if(req)fail();else{clearTimeout(timer);signal?.removeEventListener('abort',fail);reject(new PublicationCommitPermitError());}
    }
  });
}


export function createPublicationCommitPermitClient(config={}, {requestImpl=https.request}={}) {
  const {issuer,peerSecret}=config, enabled=config.enabled===true,ready=validReceiptPeerConfig(config);
  let active=0;
  return Object.freeze({async authorize(input,{signal}={}) {
    if(!enabled)throw new PublicationCommitPermitError('disabled');
    if(!ready)throw new PublicationCommitPermitError('configuration');
    if(!exact(input,['schemaVersion','receipt','target']) || input.schemaVersion!==1 ||
      !validPublicationReceipt(input.receipt) || !validPublicationCommitTarget(input.target))
      throw new PublicationCommitPermitError('invalid');
    if(active>=16)throw new PublicationCommitPermitError('busy');
    const receipt=Object.freeze({...input.receipt}),target=Object.freeze({...input.target});
    const body=JSON.stringify({schemaVersion:1,receipt,target});
    if(Buffer.byteLength(body)>4096)throw new PublicationCommitPermitError('invalid');
    active++;
    try {
      const response=await send(issuer+COMMIT_PERMIT_PATH,peerSecret,body,signal,requestImpl);
      if(signal?.aborted)throw new PublicationCommitPermitError();
      let value;
      try {value=parseStrictJson(response.text,{maxDepth:4,maxNodes:100});}catch{throw new PublicationCommitPermitError();}
      if(response.status!==200){
        const codes=response.status===403 ? {'publication.commit_denied':'denied'} :
          {'publication.commit_cancelled':'cancelled','publication.commit_conflict':'conflict'};
        if(exact(value,['error']) && exact(value.error,['code','message']) &&
          Object.hasOwn(codes,value.error.code) && typeof value.error.message==='string')
          throw new PublicationCommitPermitError(codes[value.error.code]);
        throw new PublicationCommitPermitError();
      }
      if(!exact(value,['schemaVersion','receipt','target','permitId','intentHash','authorityEpoch','authorizedAt']) ||
        value.schemaVersion!==1 || !same(value.receipt,receipt) || !same(value.target,target) ||
        !matches(value.permitId,/^pubpermit_[a-f0-9]{32}$/) || !matches(value.intentHash,hash) ||
        !Number.isInteger(value.authorityEpoch) || value.authorityEpoch<receipt.acceptanceEpoch || value.authorityEpoch>8 ||
        !validAuthorizedAt(value.authorizedAt))throw new PublicationCommitPermitError();
      Object.freeze(value.receipt); Object.freeze(value.target);
      return Object.freeze(value);
    } finally {active--;}
  }});
}

