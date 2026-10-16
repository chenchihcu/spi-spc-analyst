// D-59 auth_attempts as literally specified (re-SELECT includes own rows) vs current reserveAttempt (excludes own row, auth-core.mjs:210)
const LOCK={maxFails:5,windowMs:15*60e3,lockMs:15*60e3};
function lockUntil(times){const t=[...times].sort((a,b)=>a-b);let u=0;for(let i=LOCK.maxFails-1;i<t.length;i++)if(t[i]-t[i-LOCK.maxFails+1]<LOCK.windowMs)u=Math.max(u,t[i]+LOCK.lockMs);return u}
function run(excludeOwn,attemptsMin){const rows=[];const log=[];let verified=0;
 for(const m of attemptsMin){const now=m*60e3;const recent=rows.filter(t=>t>now-30*60e3);
  if(lockUntil(recent)>now){log.push(`${m}m:429(step1, until ${lockUntil(recent)/60e3}m)`);continue}
  rows.push(now);const again=rows.filter(t=>t>now-30*60e3);const chk=excludeOwn?again.filter((t,i,a)=>!(t===now&&i===a.lastIndexOf(now))):again;
  if(lockUntil(chk)>now){rows.pop();log.push(`${m}m:429(step2)`);continue}
  verified++;log.push(`${m}m:verified(fail)`)}
 return {verified,log:log.join(" ")}}
const seq=[0,1,2,3,14,15,16,20,28,29.5];
console.log("literal v1.5 :",run(false,seq));
console.log("current code  :",run(true,seq));
