import https from 'node:https';
import { parseStrictJson } from '../publish-validation/index.js';
import { validPublicationPeerOrigin } from './introspection.js';

export const RECEIPT_PATH = '/api/skillhub/publications/internal/cloud-receipts';
const keys = ['schemaVersion','entryRequestId','candidateRevision','acceptanceEpoch','requestHash',
  'sourceSnapshotHash','requestBytes','delegationId','idempotencyKey','taskId','eventId'];
const exact = (v, fields) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v,k));
const matches = (v,re) => typeof v === 'string' && v.match(re)?.[0] === v;
const hash = /^[a-f0-9]{64}$/;
const task = /^pubtask_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const event = /^pubevent_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class PublicationReceiptError extends Error {
  constructor(kind='unavailable') {
    const messages = {disabled:'Publication receipt delivery is disabled.',configuration:'Publication receipt configuration is unavailable.',
      invalid:'Publication receipt is invalid.',busy:'Publication receipt delivery is busy.',
      conflict:'Publication receipt conflicts with retained evidence.',unavailable:'Publication receipt delivery is unavailable.',
      storage:'Publication receipt storage is unavailable.'};
    if (!Object.hasOwn(messages,kind)) kind='unavailable';
    super(messages[kind]);
    this.name='PublicationReceiptError'; this.code=`skillhub.publication_receipt_${kind}`;
  }
}

export function validPublicationReceipt(r) {
  return exact(r,keys) && r.schemaVersion===1 && r.candidateRevision===1 &&
    Number.isInteger(r.acceptanceEpoch) && r.acceptanceEpoch>=1 && r.acceptanceEpoch<=8 &&
    Number.isSafeInteger(r.requestBytes) && r.requestBytes>=1 && r.requestBytes<=75*1024*1024 &&
    matches(r.entryRequestId,/^pubentry_[a-f0-9]{32}$/) && matches(r.delegationId,/^pubgrant_[a-f0-9]{32}$/) &&
    matches(r.idempotencyKey,/^pubcandidate_[a-f0-9]{32}$/) && matches(r.requestHash,hash) &&
    matches(r.sourceSnapshotHash,hash) && matches(r.taskId,task) && matches(r.eventId,event);
}

export function validReceiptPeerConfig({issuer,audience,peerSecret}={}) {
  return validPublicationPeerOrigin(issuer) && validPublicationPeerOrigin(audience) &&
    new URL(issuer).origin!==new URL(audience).origin && matches(peerSecret,hash);
}

// Native HTTPS only: no proxy env, redirects, caller URLs or upload credentials.
// Slots are held until transport close, including after abort or invalid replies.
function send(url,secret,body,signal,requestImpl) {
  return new Promise((resolve,reject)=>{
    let req,res,timer,result,failed=false;
    const fail=()=>{failed=true;res?.destroy();req?.destroy();};
    const finish=()=>{
      clearTimeout(timer);signal?.removeEventListener('abort',fail);
      if(failed||!result)reject(new PublicationReceiptError());else resolve(result);
    };
    if(signal?.aborted){reject(new PublicationReceiptError());return;}
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
          if(![200,409].includes(res.statusCode)||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(header('content-type')??'')||
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
      if(req)fail();else{clearTimeout(timer);signal?.removeEventListener('abort',fail);reject(new PublicationReceiptError());}
    }
  });
}

export function createPublicationReceiptClient(config={}, {requestImpl=https.request}={}) {
  const {issuer,peerSecret}=config, enabled=config.enabled===true,ready=validReceiptPeerConfig(config);
  let active=0;
  return Object.freeze({async deliver(input,{signal}={}) {
    if(!enabled)throw new PublicationReceiptError('disabled');
    if(!ready)throw new PublicationReceiptError('configuration');
    if(!validPublicationReceipt(input))throw new PublicationReceiptError('invalid');
    if(active>=16)throw new PublicationReceiptError('busy');
    const receipt=Object.freeze(Object.fromEntries(keys.map(k=>[k,input[k]])));
    active++;
    try {
      const response=await send(issuer+RECEIPT_PATH,peerSecret,JSON.stringify(receipt),signal,requestImpl);
      if(signal?.aborted)throw new PublicationReceiptError();
      let value;
      try {value=parseStrictJson(response.text,{maxDepth:4,maxNodes:64});}catch{throw new PublicationReceiptError();}
      if(response.status===409){
        if(exact(value,['error'])&&exact(value.error,['code','message'])&&value.error.code==='publication.receipt_conflict'&&typeof value.error.message==='string')throw new PublicationReceiptError('conflict');
        throw new PublicationReceiptError();
      }
      if(!exact(value,['schemaVersion','recorded','entryRequestId','eventId','taskId','localIntentCancelled','commitAllowed'])||
        value.schemaVersion!==1||value.recorded!==true||value.commitAllowed!==false||typeof value.localIntentCancelled!=='boolean'||
        value.entryRequestId!==receipt.entryRequestId||value.taskId!==receipt.taskId||value.eventId!==receipt.eventId)throw new PublicationReceiptError();
      return Object.freeze(value);
    } finally {active--;}
  }});
}
