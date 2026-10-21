// Only the persisted validator result is accepted here, never source metadata
// or an exception. Preserve its rule/repair semantics and reject unknown fields.
const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) &&
  Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const matches=(v,re)=>typeof v==='string' && re.test(v);
const hash=v=>matches(v,/^[a-f0-9]{64}$/);
const fields=new Set(['name','id','displayName','description','version','entrypoints','entrypoints.skillFile',
  'runtime','platforms','runtime.platforms','manifest']);
export function delegatedValidationReport(result,candidateHash) {
  const report=result?.status===200?result?.body?.validation:result?.status===422?result?.body?.error?.validation:null;
  if(!exact(report,['schemaVersion','ruleVersion','profile','reportId','outcome','coverage','candidateHash',
    'limitsFingerprint','issues','truncated','nextAction']) || report.schemaVersion!=='1' ||
    !matches(report.ruleVersion,/^skillhub-publish-v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/) || report.profile!=='skillhub-publish-v1' ||
    !matches(report.reportId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) ||
    report.coverage!=='complete' || !hash(report.candidateHash) || report.candidateHash!==candidateHash ||
    !hash(report.limitsFingerprint) || !Array.isArray(report.issues) || report.issues.length>50 || typeof report.truncated!=='boolean' ||
    report.outcome!==(result.status===200?'passed':'rejected') || report.nextAction!==(result.status===200?'none':'review_report'))throw Error('invalid report');
  for(const issue of report.issues) {
    if(!exact(issue,['code','category','blocking','location','message','repairPolicy']) ||
      !matches(issue.code,/^[a-z][a-z0-9_]{0,47}\.[a-z][a-z0-9_]{0,63}$/) ||
      !['format','package_safety','compatibility'].includes(issue.category) || typeof issue.blocking!=='boolean' ||
      !['manual','confirmation_required','none'].includes(issue.repairPolicy) ||
      (issue.code==='metadata.description_missing' && issue.repairPolicy!=='confirmation_required') ||
      typeof issue.message!=='string' || !issue.message || !issue.message.isWellFormed() ||
      Buffer.byteLength(issue.message)>1024 || /[\x00-\x1f\x7f]/.test(issue.message))throw Error('invalid issue');
    const loc=issue.location;
    if(!loc || typeof loc!=='object' || Array.isArray(loc) || Object.keys(loc).some(k=>!['entryIndex','relativePath','field'].includes(k)) ||
      (Object.hasOwn(loc,'entryIndex') && (!Number.isSafeInteger(loc.entryIndex) || loc.entryIndex<0)) ||
      (Object.hasOwn(loc,'relativePath') && !['SKILL.md','skill.json','README.md'].includes(loc.relativePath)) ||
      (Object.hasOwn(loc,'field') && !fields.has(loc.field)))throw Error('invalid location');
  }
  const blocking=report.issues.some(i=>i.blocking);
  if((report.outcome==='passed' && blocking) || (report.outcome==='rejected' && !blocking && !report.truncated) ||
    Buffer.byteLength(JSON.stringify({validation:report},null,2)+'\n')>48*1024)throw Error('invalid report budget');
  return structuredClone(report);
}
