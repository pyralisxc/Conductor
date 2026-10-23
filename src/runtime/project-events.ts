import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { type AuthInfo } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clientFingerprint } from '../transport/work-scope.js';
import { requireOAuthGrant, type OAuthGrantStore } from '../transport/oauth-grant-store.js';
import { callbackUrl, signingKey, verifyCallback, signedCallback, type CallbackPost } from '../transport/event-callback.js';
import { RedisPrEventStore, prEventArguments, prEventIntegrationBranch, eventOwner, type EventOwner, type PrEventState, type PrEventSnapshot } from './pr-events.js';
import type { VersionedProviderCredentialVault } from '../connections/universal/credential-vault.js';

export const PROJECT_EVENT = 'project.pull_request_changed';
export const projectEventArguments = z.object({
  repository: prEventArguments.shape.repository,
  integrationBranch: prEventIntegrationBranch,
}).strict();
export type ProjectEventArguments = z.infer<typeof projectEventArguments>;
export const projectRelationship = projectEventArguments.extend({
  id: z.uuid(), installationId: z.number().int().positive(), expiresAt: z.number().int().positive(),
}).strict();
export type ProjectRelationship = z.infer<typeof projectRelationship>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Subscription = NonNullable<PrEventState['subscription']>;
type State = PrEventState & { baselines?: Record<string,string>; projectPhase?: 'pending'|'challenging'|'active' };
export function projectEventCatalog() {
  return { events: [{ name: PROJECT_EVENT,
    description: 'Authorized repository/Preview-branch PR and check transitions. Every callback carries current exact PR head/base evidence; receiver must reread before acting.',
    delivery: ['webhook'],
    inputSchema: z.toJSONSchema(projectEventArguments),
    payloadSchema: { type: 'object', properties: {
      repository:{type:'string'}, integrationBranch:{type:'string'}, pullRequestNumber:{type:'integer'},
      headSha:{type:'string'}, baseSha:{type:'string'}, state:{type:'string'}, draft:{type:'boolean'},
      merged:{type:'boolean'}, checks:{type:'object'}, url:{type:'string'},
    }, required:['repository','integrationBranch','pullRequestNumber','headSha','baseSha','state','draft','merged','checks','url'],
      additionalProperties:false },
  }] };
}
export interface ProjectEventsOptions {
  relationships: ProjectRelationship[]; owner:{issuer:string;subject:string}; clientFingerprint:string;
  redis: Redis; grants:OAuthGrantStore; vault:VersionedProviderCredentialVault;
  post:CallbackPost; webhookSecret:string; now?:()=>number;
  validateRecipient:(url:string)=>Promise<void>;
  source:{read(owner:EventOwner,relationship:ProjectRelationship,prNumber:number,generation:string):Promise<PrEventSnapshot>};
}
/** Additive project event lane. Exact-PR PrEvents mode is unchanged. No implicit relationship activation. */
export class ProjectEvents {
  private readonly now:()=>number;
  constructor(private readonly options:ProjectEventsOptions) {
    this.now=options.now??Date.now;
    if(options.relationships.length<1||options.relationships.length>8)throw new Error('Relationship capacity');
    if(new Set(options.relationships.map(r=>r.repository+':'+r.integrationBranch)).size!==options.relationships.length
      ||new Set(options.relationships.map(r=>r.id)).size!==options.relationships.length)throw new Error('Duplicate relationship');
    if(!/^[a-f0-9]{64}$/.test(options.clientFingerprint)||options.webhookSecret.length<32)throw new Error('Invalid event configuration');
  }
  private relation(args:ProjectEventArguments) {
    const v=projectEventArguments.parse(args);
    const rel=this.options.relationships.find(x=>x.repository===v.repository&&x.integrationBranch===v.integrationBranch);
    if(!rel)throw new Error('Relationship not configured');
    return rel;
  }
  private key(rel:ProjectRelationship) {return 'conductor:preview:project-events:authority:'+rel.id;}
  private marker(rel:ProjectRelationship) {return 'active:'+hash([rel.id,rel.repository,rel.integrationBranch,rel.installationId,rel.expiresAt,this.options.owner,this.options.clientFingerprint]);}
  private store(rel:ProjectRelationship) {
    return new RedisPrEventStore(this.options.redis,'conductor:preview:project-events:v1:'+
      hash([rel.id,rel.repository,rel.integrationBranch,this.options.clientFingerprint,PROJECT_EVENT]));
  }
  private async authorizedRelationship(rel:ProjectRelationship) {
    if(rel.expiresAt<=this.now()||(await this.options.redis.get(this.key(rel)))!==this.marker(rel))throw new Error('Relationship not active');
  }
  private async principal(auth:AuthInfo|undefined) {
    const owner=eventOwner(auth);
    if(owner.issuer!==this.options.owner.issuer||owner.subject!==this.options.owner.subject||
      clientFingerprint(owner.clientId)!==this.options.clientFingerprint)throw new Error('Project client unauthorized');
    const generation=auth?.extra?.grantGeneration;
    const grant=await requireOAuthGrant(this.options.grants,owner,generation,['conductor.read'],this.now);
    return {owner,generation:generation as string,grant};
  }
  private async authorize(auth:AuthInfo|undefined,rel:ProjectRelationship) {
    const identity=await this.principal(auth);
    await this.authorizedRelationship(rel);
    return identity;
  }
  private async check(rel:ProjectRelationship,sub:Subscription) {
    await this.authorizedRelationship(rel);
    if(sub.eventName!==PROJECT_EVENT||sub.expiresAt<=this.now()||
      sub.owner.issuer!==this.options.owner.issuer||sub.owner.subject!==this.options.owner.subject||
      clientFingerprint(sub.owner.clientId)!==this.options.clientFingerprint||
      sub.id!==this.id(rel,sub.owner,sub.url))throw new Error('Inactive subscription');
    await requireOAuthGrant(this.options.grants,sub.owner,sub.generation,['conductor.read'],this.now);
    await this.authorizedRelationship(rel);
  }
  private id(rel:ProjectRelationship,owner:EventOwner,url:string) {
    return 'sub_'+hash([rel.id,owner.issuer,owner.subject,owner.clientId,PROJECT_EVENT,url]);
  }
  private async evidence(rel:ProjectRelationship,owner:EventOwner,generation:string,number:number) {
    await this.authorizedRelationship(rel);
    await requireOAuthGrant(this.options.grants,owner,generation,['conductor.read'],this.now);
    const p=await this.options.source.read(owner,rel,number,generation);
    await requireOAuthGrant(this.options.grants,owner,generation,['conductor.read'],this.now);
    await this.authorizedRelationship(rel);
    if(p.repository!==rel.repository||p.pullRequestNumber!==number||p.base.ref!==rel.integrationBranch||
      !/^[a-f0-9]{40}$/.test(p.head.sha)||!/^[a-f0-9]{40}$/.test(p.base.sha))throw new Error('PR identity changed');
    return { repository:rel.repository,integrationBranch:rel.integrationBranch,pullRequestNumber:number,
      headSha:p.head.sha,baseSha:p.base.sha,state:p.state,draft:p.draft,merged:p.merged,
      checks:{total:p.checks.total,pending:p.checks.pending,successful:p.checks.successful,
        failed:p.checks.failed,neutral:p.checks.neutral,skipped:p.checks.skipped},
      url:'https://github.com/'+rel.repository+'/pull/'+number,...(p.reviews?{reviews:p.reviews}:{}) };
  }
  list(auth:AuthInfo|undefined) {
    const o=eventOwner(auth);
    if(o.issuer!==this.options.owner.issuer||o.subject!==this.options.owner.subject||
      clientFingerprint(o.clientId)!==this.options.clientFingerprint)throw new Error('Unauthorized catalog');
    return projectEventCatalog();
  }
  /** Explicit initial project enable: missing Redis authority never becomes active after key loss. */
  async enable(auth:AuthInfo|undefined,args:ProjectEventArguments,id:string,approvalReference:string) {
    const rel=this.relation(args),{owner,generation}=await this.principal(auth);
    if(id!==rel.id||!/^owner-approved:\S/.test(approvalReference)||rel.expiresAt<=this.now())
      throw new Error('Exact relationship approval required');
    await requireOAuthGrant(this.options.grants,owner,generation,['conductor.read','conductor.write'],this.now);
    const created=await this.options.redis.eval(
      "if redis.call('EXISTS',KEYS[1])~=0 then return 0 end; redis.call('SET',KEYS[1],ARGV[1]); return 1",
      [this.key(rel)],[this.marker(rel)]);
    if(Number(created)!==1)throw new Error('Relationship already established or revoked');
    return {active:true,relationshipId:rel.id,repository:rel.repository,integrationBranch:rel.integrationBranch};
  }
  /** Scoped revocation survives restart. Missing authority is always non-delivering. */
  async revoke(auth:AuthInfo|undefined,args:ProjectEventArguments,id:string,approvalReference:string) {
    const rel=this.relation(args),{owner,generation}=await this.principal(auth);
    if(id!==rel.id||!/^owner-approved:\S/.test(approvalReference))throw new Error('Exact relationship approval required');
    await requireOAuthGrant(this.options.grants,owner,generation,['conductor.read','conductor.write'],this.now);
    const result=await this.options.redis.eval(
      "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end;redis.call('SET',KEYS[1],'revoked');return 1",
      [this.key(rel)],[this.marker(rel)]);
    if(Number(result)!==1)throw new Error('Relationship not active or concurrent change');
    return {revoked:true,relationshipId:rel.id,repository:rel.repository,integrationBranch:rel.integrationBranch};
  }
  async subscribe(auth:AuthInfo|undefined,args:ProjectEventArguments,delivery:{url:string;secret:string},ttlMs?:number|null,name:string=PROJECT_EVENT) {
    if(name!==PROJECT_EVENT)throw new Error('Unsupported event');
    const rel=this.relation(args),{owner,generation,grant}=await this.authorize(auth,rel);
    const url=callbackUrl(delivery.url,new URL(delivery.url).hostname).toString();signingKey(delivery.secret);
    const store=this.store(rel),loaded=await store.load(),prior=loaded.state.subscription;
    const id=this.id(rel,owner,url);
    if(prior&&(prior.id!==id||prior.generation!==generation||prior.eventName!==PROJECT_EVENT))
      throw new Error('Project recipient/generation change requires unsubscribe');
    const state=loaded.state as State;
    if(prior&&state.projectPhase!=='active')throw new Error('Pending project challenge requires explicit unsubscribe');
    const existingSecret=prior?this.options.vault.open(prior.secret).plaintext:null;
    const expiresAt=Math.min(rel.expiresAt,grant.expiresAt,
      this.now()+Math.min(ttlMs??3600000,3600000),auth?.expiresAt===undefined?Infinity:auth.expiresAt*1000);
    if(expiresAt<=this.now())throw new Error('Project lease expired');
    const sub:Subscription={id,owner,generation,url,secret:this.options.vault.seal(delivery.secret),
      eventName:PROJECT_EVENT,expiresAt,verifiedUntil:this.now()+300000,
      ...(prior&&existingSecret!==delivery.secret?{previousSecret:prior.secret,rotationUntil:this.now()+60000}:
      prior?.previousSecret&&(prior.rotationUntil??0)>this.now()?
      {previousSecret:prior.previousSecret,rotationUntil:prior.rotationUntil}:{})};
    const needsChallenge=!prior||existingSecret!==delivery.secret||prior.expiresAt<=this.now();
    if(needsChallenge) {
      // Claim pending/challenging before the first network request. Concurrent losers send no challenge.
      const pending:State={...state,subscription:sub,projectPhase:'pending'};
      await this.authorizedRelationship(rel);
      if(!await store.save(loaded.version,pending))throw new Error('Pending project claim changed');
      const observed=await store.load();
      if(observed.version!==JSON.stringify(pending))throw new Error('Pending project claim changed');
      const challenging=observed.state as State;
      if(challenging.subscription?.id!==id||challenging.projectPhase!=='pending')throw new Error('Project challenge claim changed');
      challenging.projectPhase='challenging';
      if(!await store.save(observed.version,challenging))throw new Error('Project challenge claim changed');
      await this.options.validateRecipient(url);
      await verifyCallback(async(...a)=>{
        await this.authorizedRelationship(rel);
        await requireOAuthGrant(this.options.grants,owner,generation,['conductor.read'],this.now);
        return this.options.post(...a);
      },{id,url,secret:delivery.secret});
      await this.authorize(auth,rel);
      const after=await store.load(),current=after.state as State;
      if(after.version!==JSON.stringify(challenging)||current.projectPhase!=='challenging'
        ||current.subscription?.id!==id||current.subscription.generation!==generation)throw new Error('Project activation changed');
      current.projectPhase='active';
      if(!await store.save(after.version,current))throw new Error('Project activation changed');
    } else {
      await this.authorizedRelationship(rel);
      if(!await store.save(loaded.version,{...state,subscription:sub}))throw new Error('Project lease CAS conflict');
    }
    await this.check(rel,sub);
    return {id,refreshBefore:new Date(expiresAt).toISOString(),cursor:null,truncated:false};
  }
  async unsubscribe(auth:AuthInfo|undefined,args:ProjectEventArguments,url:string,name:string=PROJECT_EVENT) {
    if(name!==PROJECT_EVENT)throw new Error('Unsupported event');
    const rel=this.relation(args),{owner}=await this.principal(auth);
    const canonical=callbackUrl(url,new URL(url).hostname).toString(),store=this.store(rel);
    for(let i=0;i<3;i++){const loaded=await store.load(),sub=loaded.state.subscription;
      if(!sub)return {};
      if(sub.id!==this.id(rel,owner,canonical))throw new Error('Project recipient mismatch');
      delete loaded.state.subscription;
      delete (loaded.state as State).projectPhase;
      if(await store.save(loaded.version,loaded.state))return {};
    }
    throw new Error('Project unsubscribe CAS conflict');
  }
  private async reconcile(rel:ProjectRelationship,number:number,source:string) {
    const store=this.store(rel),loaded=await store.load(),state=loaded.state as State,sub=state.subscription;
    if(!sub||state.projectPhase!=='active')return 'inactive';
    try{await this.check(rel,sub);}catch{return 'blocked';}
    const scoped=source+':'+number;
    if(state.sources?.some(s=>s.id===scoped))return 'duplicate';
    state.sources=(state.sources??[]).filter(s=>s.observedAt>this.now()-86400000);
    if(state.sources.length>=256)return 'capacity';
    const data=await this.evidence(rel,sub.owner,sub.generation,number);
    const version=hash(data),key=String(number);
    state.baselines=state.baselines??{};
    if(Object.keys(state.baselines).length>=64&&!Object.hasOwn(state.baselines,key))return 'capacity';
    state.sources.push({id:scoped,observedAt:this.now()});
    if(state.baselines[key]===version)return await store.save(loaded.version,state)?'unchanged':'pending';
    state.deliveries=state.deliveries.filter(d=>d.createdAt>this.now()-86400000);
    if(state.deliveries.length>=128)return 'capacity';
    const id='evt_'+hash([sub.id,scoped,version]);
    const record={id,source:scoped,fingerprint:version,createdAt:this.now(),attempts:0,
      status:'pending' as const,body:JSON.stringify({eventId:id,name:PROJECT_EVENT,
        timestamp:new Date(this.now()).toISOString(),data,cursor:null})};
    state.deliveries.push(record);state.baselines[key]=version;
    if(!await store.save(loaded.version,state))return 'pending';
    const claimed=await store.load(),live=claimed.state.subscription;
    if((claimed.state as State).projectPhase!=='active')return 'inactive';
    const entry=claimed.state.deliveries.find(d=>d.id===id);
    if(!live||live.id!==sub.id||live.generation!==sub.generation||!entry||entry.attempts!==0)
      return 'pending';
    try{await this.check(rel,live);
      if(hash(await this.evidence(rel,live.owner,live.generation,number))!==version)return 'superseded';
    }catch{return 'blocked';}
    entry.attempts=1;entry.leaseUntil=this.now()+30000;
    if(!await store.save(claimed.version,claimed.state))return 'pending';
    const after=await store.load(),current=after.state.subscription;
    if((after.state as State).projectPhase!=='active'||!current||current.id!==sub.id||current.generation!==sub.generation)return 'inactive';
    try{await this.check(rel,current);
      if(hash(await this.evidence(rel,current.owner,current.generation,number))!==version)return 'superseded';
    }catch{return 'blocked';}
    let status:number|undefined;
    try{status=(await signedCallback(this.options.post,{id:current.id,url:current.url,
      secret:this.options.vault.open(current.secret).plaintext,
      ...(current.previousSecret&&(current.rotationUntil??0)>this.now()?
      {previousSecret:this.options.vault.open(current.previousSecret).plaintext}:{})},id,record.body)).status;}catch{}
    try{await this.check(rel,current);}catch{return 'blocked';}
    const terminal=status!==undefined&&status>=200&&status<300?'accepted':
      status===410?'stopped':'uncertain';
    for(let i=0;i<3;i++){const latest=await store.load(),row=latest.state.deliveries.find(d=>d.id===id);
      if(!row||(latest.state as State).projectPhase!=='active'||latest.state.subscription?.id!==sub.id||latest.state.subscription.generation!==sub.generation)return 'uncertain';
      if(row.status!=='pending')return row.status;
      row.status=terminal;row.leaseUntil=0;
      if(await store.save(latest.version,latest.state))return terminal;
    }
    return 'uncertain';
  }
  async ingest(body:Buffer,event:string,deliveryId:string,signature:string):Promise<string> {
    if(body.length>262144||!/^[A-Za-z0-9-]{1,100}$/.test(deliveryId)||
      !/^sha256=[a-f0-9]{64}$/.test(signature))throw new Error('Invalid provider delivery');
    const expected=createHmac('sha256',this.options.webhookSecret).update(body).digest();
    if(!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex')))throw new Error('Invalid provider signature');
    const payload=JSON.parse(body.toString('utf8'));
    const actions:Record<string,string[]>={pull_request:['opened','reopened','synchronize','ready_for_review','converted_to_draft','closed'],
      check_run:['created','completed','rerequested'],check_suite:['completed','rerequested'],
      pull_request_review:['submitted','edited','dismissed'],pull_request_review_comment:['created','edited','deleted']};
    if(!actions[event]?.includes(payload.action))return 'ignored';
    const rel=this.options.relationships.find(r=>r.repository===payload.repository?.full_name&&
      r.installationId===payload.installation?.id);
    if(!rel)return 'ignored';
    if(event.startsWith('pull_request')) {
      if(payload.pull_request?.base?.ref!==rel.integrationBranch)return 'ignored';
      const number=payload.pull_request?.number;
      if(!Number.isInteger(number)||number<=0)return 'ignored';
      return this.reconcile(rel,number,rel.repository+':'+deliveryId);
    }
    const check=payload[event];
    if(!/^[a-f0-9]{40}$/.test(check?.head_sha))return 'ignored';
    const numbers=[...new Set((Array.isArray(check?.pull_requests)?check.pull_requests:[]).map(
      (p:{number?:number})=>p.number).filter((x:unknown)=>typeof x==='number'&&Number.isInteger(x)&&x>0))].slice(0,4) as number[];
    if(numbers.length===0)return 'ignored';
    let outcome='unchanged';
    for(const number of numbers){
      const value=await this.reconcile(rel,number,rel.repository+':'+deliveryId);
      if(value==='pending'||value==='blocked'||value==='uncertain')return value;
      if(value==='accepted')outcome='accepted';
    }
    return outcome;
  }
}
