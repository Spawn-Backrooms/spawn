// Deliberately synthetic authority/transport: not production privacy, funding,
// checker, settlement, or durable-runtime evidence.
export function conformanceCases(api, hash) {
  const { VERSION, canonicalJson, parseEnvelope, parseCapability, verifyEnvelope, originalScope } = api;
  const must=(ok,label="assertion")=>{if(!ok)throw Error(label)};
  const eq=(a,b)=>must(canonicalJson(a)===canonicalJson(b),"not equal");
  const rejects=async(fn,code)=>{try{await fn()}catch(e){if(code)must(e.message===code,e.message);return}throw Error("expected rejection")};
  const room=(room_ref,project_ref)=>({room_ref,project_ref});
  const M=room("main","project_main"), A=room("private_a","project_a"), B=room("private_b","project_b"), S=room("specialist","project_s");
  const scope={agenda_id:"agenda",question_id:"question",assignment_id:"assignment"};
  const who=(r)=>({principal_ref:"owner_"+r.project_ref,installation_ref:null,agent_ref:"agent_"+r.room_ref});
  const external=(r)=>({mode:"external_self",payer_ref:who(r).principal_ref,cap_micro_usd:null,authorization_ref:null});
  const byteLength=text=>new TextEncoder().encode(text).byteLength;
  const d=async()=>hash("fixture");
  async function build(source,target,thread,sequence,reply,payload,purpose="research",overrides={}) {
    const value={version:VERSION,assignment:scope,source,target,actor:who(source),message_id:thread+"_"+sequence,
      thread_id:thread,sequence,reply_to:reply,original_key:thread+"_"+sequence,
      grant:{ref:"grant_"+source.room_ref+"_"+target.room_ref,epoch:1},
      disclosure:{decision_ref:"decision_"+thread+"_"+sequence,policy_sha256:await d(),purpose,recipient:target},
      expires_at_ms:1000,payload,payload_sha256:await hash(canonicalJson(payload)),...overrides};
    return value;
  }
  async function request(from,to,thread,opts={}) {
    const p={kind:"request",purpose:"research",question_sha256:await d(),input:null,capability:null,budget:external(from),parent_thread:null,...opts};
    return build(from,to,thread,1,null,p,p.purpose);
  }
  async function file(text="theorem harmless : True := True.intro\n") {
    return {kind:"file",manifest_ref:"manifest",manifest_sha256:await d(),artifact_ref:"proof",sha256:await hash(text),size_bytes:byteLength(text)};
  }
  async function candidate(text,room=A,candidate_id="c1",supporting_evidence=[]) {
    return {candidate_id,revision:1,parent_sha256:null,statement_sha256:await d(),
      producer_ref:who(room).agent_ref,source:await file(text),checker_policy_sha256:await d(),supporting_evidence};
  }
  // Each test creates a new isolated store. Grants/approval records are
  // deliberately populated OUT OF BAND by the fixture, not by a message.
  function fake() {
    const grants=new Map(), decisions=new Map(), originals=new Map(), threads=new Map(), objects=new Map(), reviews=new Map(), candidates=new Map(), approvedBudgets=new Set(), effects=new Map();
    const latest=new Map();
    const scoped=(assignment,id)=>canonicalJson([assignment,id]);
    let charges=0;
    const gate=(v,identity,now=10)=>{
      must(identity.principal_ref===v.actor.principal_ref&&identity.installation_ref===v.actor.installation_ref&&identity.agent_ref===v.actor.agent_ref,"AUTH_ACTOR");
      const g=grants.get(v.grant.ref);
      must(g&&g.active&&g.epoch===v.grant.epoch&&v.expires_at_ms>now,"AUTH_GRANT");
      eq(g.actor,v.actor);eq(g.source,v.source);eq(g.target,v.target);eq(g.assignment,v.assignment);
      const p=decisions.get(v.disclosure.decision_ref);
      must(p&&p.active&&p.payload===v.payload_sha256,"AUTH_DISCLOSURE"); eq(p.recipient,v.target);eq(p.purpose,v.disclosure.purpose);
      eq(p.policy,v.disclosure.policy_sha256);eq(p.grant,v.grant);eq(p.assignment,v.assignment);
    };
    function approve(v) {
      grants.set(v.grant.ref,{active:true,epoch:v.grant.epoch,actor:v.actor,source:v.source,target:v.target,assignment:v.assignment});
      decisions.set(v.disclosure.decision_ref,{active:true,payload:v.payload_sha256,recipient:v.target,purpose:v.disclosure.purpose,
        policy:v.disclosure.policy_sha256,grant:v.grant,assignment:v.assignment});
    }
    async function send(raw,identity=raw.actor) {
      const {envelope:v,envelope_sha256:h}=await verifyEnvelope(raw,hash);
      gate(v,identity); const key=originalScope(v), old=originals.get(key);
      if(old){must(old.hash===h,"ORIGINAL_CONFLICT");return old.receipt}
      const t=threads.get(v.thread_id);
      const p=v.payload;
      let reverse=false;
      if(!t) {
        must(v.payload.kind==="request"&&v.sequence===1,"THREAD_START");
        if(v.payload.parent_thread!==null){
          const parent=threads.get(v.payload.parent_thread);
          must(parent&&parent.parent===null&&!parent.closed&&parent.state==="accepted","DEPTH_OR_PARENT");
          must(canonicalJson(parent.assignment)===canonicalJson(v.assignment),"PARENT_ASSIGNMENT");
          must(canonicalJson(parent.first.target)===canonicalJson(v.source),"PARENT_ACTOR");
          must(canonicalJson(parent.first.source)!==canonicalJson(v.target),"CYCLE");
          must(p.purpose==="specialist"&&parent.activeSpecialist===null&&parent.specialistAttempts<3,"FANOUT");
        }
        if(v.payload.budget.mode!=="external_self")must(approvedBudgets.has(v.payload.budget.authorization_ref),"BUDGET_REQUIRED");
      }else{
        must(!t.closed&&v.sequence===t.sequence+1&&v.reply_to===t.last,"STALE_OR_ORDER");
        must(canonicalJson(t.assignment)===canonicalJson(v.assignment),"THREAD_ASSIGNMENT");
        const forward=canonicalJson(t.first.source)===canonicalJson(v.source)&&canonicalJson(t.first.target)===canonicalJson(v.target);
        reverse=canonicalJson(t.first.target)===canonicalJson(v.source)&&canonicalJson(t.first.source)===canonicalJson(v.target);
        must(forward||reverse,"THREAD_PARTY");
        if(t.state==="requested"){
          const allowed=p.kind==="clarify" || (forward&&p.kind==="cancel") || (reverse&&["accept","decline"].includes(p.kind));
          must(allowed,"NOT_ACCEPTED");
        }
        if(p.kind==="accept"||p.kind==="decline")must(t.state==="requested"&&reverse,"ACCEPT_STATE");
      }
      let candidateHash=null;
      if(p.kind==="candidate"||p.kind==="correction"){
        must(p.candidate.producer_ref===identity.agent_ref,"PRODUCER");
        if(t.first.payload.purpose==="specialist")must(reverse&&canonicalJson(t.acceptedBy)===canonicalJson(identity),"SPECIALIST_SENDER");
        for(const dependency of p.candidate.supporting_evidence){
          const known=candidates.get(scoped(v.assignment,dependency.candidate_sha256));
          must(known&&canonicalJson(known.source)===canonicalJson(dependency.source),"SUPPORT_MISMATCH");
        }
        const oldCandidate=latest.get(scoped(v.assignment,p.candidate.candidate_id));
        if(oldCandidate)must(p.candidate.revision===oldCandidate.revision+1&&p.candidate.parent_sha256===oldCandidate.hash,"CANDIDATE_REVISION");
        else must(p.candidate.revision===1,"CANDIDATE_FIRST");
        candidateHash=await hash(canonicalJson(p.candidate));
      }
      if(p.kind==="review_request"||p.kind==="review"){
        must(t.state==="accepted"&&t.first.payload.purpose==="review"&&v.disclosure.purpose==="review","REVIEW_STATE");
        const selected=candidates.get(scoped(v.assignment,p.candidate_sha256));
        if(p.kind==="review_request"){
          must(!reverse&&t.selected===null&&selected&&canonicalJson(t.first.payload.input)===canonicalJson(selected.source),"REVIEW_SELECTION");
          t.selected=p.candidate_sha256;
        }else{
          must(reverse&&t.selected===p.candidate_sha256&&!reviews.has(v.thread_id)&&canonicalJson(t.acceptedBy)===canonicalJson(identity),"REVIEW_SELECTION");
          must(selected.principal!==identity.principal_ref,"INDEPENDENT_REVIEW");
          reviews.set(v.thread_id,{candidate_sha256:t.selected,verdict:p.verdict});
        }
      }
      if(candidateHash){
        const record={hash:candidateHash,revision:p.candidate.revision,principal:identity.principal_ref,source:p.candidate.source};
        candidates.set(scoped(v.assignment,candidateHash),record);
        latest.set(scoped(v.assignment,p.candidate.candidate_id),record);
      }
      const receipt={message_id:v.message_id,hash:h,transport:"synthetic",platform_charge_micro_usd:"0"};
      if(!t){
        threads.set(v.thread_id,{first:v,sequence:1,last:v.message_id,assignment:v.assignment,parent:p.parent_thread,closed:false,state:"requested",activeSpecialist:null,specialistAttempts:0,acceptedBy:null,selected:null});
        if(p.parent_thread!==null){
          const parent=threads.get(p.parent_thread);
          parent.activeSpecialist=v.thread_id;
          parent.specialistAttempts++;
        }
      }else{
        t.sequence=v.sequence;t.last=v.message_id;
        if(p.kind==="accept"){t.state="accepted";t.acceptedBy=v.actor;}
        if(["decline","cancel","withdraw"].includes(p.kind)||(t.parent!==null&&candidateHash)){
          t.closed=true;
          if(t.parent!==null)threads.get(t.parent).activeSpecialist=null;
        }
      }
      originals.set(key,{hash:h,receipt});return receipt;
    }
    async function retain(ref,text) { must(await hash(text)===ref.sha256&&byteLength(text)===ref.size_bytes,"BYTES");objects.set(ref.sha256,text); }
    async function read(ref,grant,actor,now=10) {
      // Read permission is separate from possession of the source digest.
      must(grant.active&&grant.expires>now&&grant.principal===actor.principal_ref&&grant.sha256===ref.sha256,"READ_DENIED");
      const text=objects.get(ref.sha256);must(typeof text==="string"&&await hash(text)===ref.sha256&&byteLength(text)===ref.size_bytes,"BYTES");return text;
    }
    function reserveOriginal(key) {
      if(effects.has(key))return effects.get(key);
      const record={state:"unknown",charge:"held"};effects.set(key,record);return record;
    }
    return {approve,send,retain,read,grants,decisions,objects,reviews,candidates,reserveOriginal,approvedBudgets,get charges(){return charges}};
  }
  async function reply(store,previous,from,to,payload,overrides={}) {
    const message=await build(from,to,previous.thread_id,previous.sequence+1,previous.message_id,payload,
      previous.disclosure.purpose,{assignment:previous.assignment,...overrides});
    store.approve(message);
    await store.send(message);
    return message;
  }
  async function deliver(store,from,to,thread,purpose="research",opts={},assignment=scope) {
    const start=await request(from,to,thread,{purpose,...opts});
    start.assignment=assignment;
    store.approve(start);await store.send(start);
    return reply(store,start,to,from,{kind:"accept",reason:"accepted"});
  }
  return [
    {name:"canonical order and known SHA-256 vector",run:async()=>{
      eq(canonicalJson({z:1,a:"é"}),'{"a":"é","z":1}');
      must(await hash("abc")==="sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","SHA-256 vector");
      await rejects(()=>canonicalJson({a:"\ud800"}));await rejects(()=>canonicalJson({a:undefined}));
      await rejects(()=>canonicalJson({get a(){throw Error("accessed")}}));
      await rejects(()=>canonicalJson({a:"x".repeat(32769)}));
      await rejects(()=>canonicalJson({a:["é".repeat(16384)]}),"RESEARCH_SIZE");
    }},
    {name:"wire validation, digest tampering and unsupported version",run:async()=>{
      const v=await request(A,M,"t");const r=await verifyEnvelope(v,hash);eq(r.envelope,v);
      await rejects(()=>verifyEnvelope({...v,version:"unknown"},hash),"RESEARCH_VERSION");
      await rejects(()=>verifyEnvelope({...v,payload:{...v.payload,question_sha256:awaitedBad()}},hash),"RESEARCH_PAYLOAD_DIGEST");
      await rejects(()=>parseEnvelope({...v,extra:"private"}));
      await rejects(()=>parseEnvelope({...v,disclosure:{...v.disclosure,recipient:B}}),"RESEARCH_RECIPIENT");
      await rejects(()=>parseEnvelope({...v,payload:{...v.payload,budget:{...v.payload.budget,cap_micro_usd:"1"}}}));
      function awaitedBad(){return "sha256:"+"0".repeat(64)}
    }},
    {name:"git source pins, unsafe paths and duplicate files",run:async()=>{
      const f={path:"Proof.lean",sha256:await d(),size_bytes:12};
      const g={kind:"git",repo_ref:"isolated_repo",base:"1".repeat(40),commit:"2".repeat(40),tree:"3".repeat(40),files:[f]};
      const v=await request(A,M,"g",{input:g});parseEnvelope(v);
      for(const bad of ["../secret","/root","a\\\\b",".git/config","a//b"]){
        await rejects(()=>parseEnvelope({...v,payload:{...v.payload,input:{...g,files:[{...f,path:bad}]}}}));
      }
      await rejects(()=>parseEnvelope({...v,payload:{...v.payload,input:{...g,files:[f,f]}}}));
    }},
    {name:"four-room collaboration, selected source and offline reviewer",run:async()=>{
      const store=fake(), sentinel="PRIVATE_ONLY_NOT_EXPORTED";
      const privateNotes=new Map([[A.room_ref,sentinel],[S.room_ref,"SPECIALIST_PRIVATE_NOTES"]]);
      const start=await deliver(store,M,A,"main");
      const cap={version:VERSION,capability_id:"math",revision:1,input_schema_sha256:await d(),output_schema_sha256:await d(),disclosure_policy_sha256:await d(),visibility:"invite_only",available:true,budget_modes:["external_self"]};
      parseCapability(cap);
      const specialist=await deliver(store,A,S,"specialist","specialist",{parent_thread:"main",capability:{capability_id:"math",revision:1,descriptor_sha256:await hash(canonicalJson(cap))}});
      const supportText="theorem supporting : True := True.intro\n";
      const support=await candidate(supportText,S,"specialist_c1");
      await store.retain(support.source,supportText);
      const progress=await build(S,A,"specialist",3,specialist.message_id,{kind:"candidate",candidate:support},"specialist");store.approve(progress);await store.send(progress);
      const supportHash=await hash(canonicalJson(support));
      const supportRead={active:true,expires:100,principal:who(A).principal_ref,sha256:support.source.sha256};
      eq(await store.read(support.source,supportRead,who(A)),supportText);
      const text="theorem harmless : ∀ p : Prop, p → p := fun _ h => h\n",c=await candidate(text,A,"c1",[{candidate_sha256:supportHash,source:support.source}]);
      const wrongSize={...c.source,size_bytes:text.length};
      must(c.source.size_bytes>wrongSize.size_bytes);
      await rejects(()=>store.retain(wrongSize,text),"BYTES");
      await store.retain(c.source,text);
      const delivery=await build(A,M,"main",3,start.message_id,{kind:"candidate",candidate:c});store.approve(delivery);await store.send(delivery);
      const review=await deliver(store,M,B,"review","review",{input:c.source});
      const selection=await reply(store,review,M,B,{kind:"review_request",candidate_sha256:await hash(canonicalJson(c))});
      const readGrant={active:true,expires:100,principal:who(B).principal_ref,sha256:c.source.sha256};
      store.grants.get(delivery.grant.ref).active=false; // author disconnected/revoked
      eq(await store.read(c.source,readGrant,who(B)),text);
      await rejects(()=>store.read(wrongSize,readGrant,who(B)),"BYTES");
      await rejects(()=>store.read(c.source,readGrant,who(S)),"READ_DENIED");
      const result=await reply(store,selection,B,M,{kind:"review",candidate_sha256:await hash(canonicalJson(c)),verdict:"approve",evidence_sha256:await d()});
      must(store.reviews.size===1&&store.charges===0);
      must(privateNotes.get(A.room_ref)===sentinel);
      must(!canonicalJson([delivery,progress,result]).includes(sentinel)&&!canonicalJson([delivery,progress,result]).includes(privateNotes.get(S.room_ref)));
      await rejects(()=>store.read(support.source,supportRead,who(B)),"READ_DENIED");
      store.objects.set(c.source.sha256,text+"tamper");await rejects(()=>store.read(c.source,readGrant,who(B)),"BYTES");
    }},
    {name:"replay, conflicting original, wrong actor and revoked grant",run:async()=>{
      const store=fake(),v=await request(A,M,"t");store.approve(v);
      const a=await store.send(v);eq(await store.send(v),a);
      await rejects(()=>store.send(v,who(B)),"AUTH_ACTOR");
      const changed={...v,message_id:"changed"};store.approve(changed);
      await rejects(()=>store.send(changed),"ORIGINAL_CONFLICT");
      store.grants.get(v.grant.ref).active=false;await rejects(()=>store.send(v),"AUTH_GRANT");
      const effect=store.reserveOriginal("call");must(store.reserveOriginal("call")===effect&&effect.state==="unknown");
    }},
    {name:"same owner different room, no implicit permission or spend",run:async()=>{
      const store=fake(),same=room("private_a2",A.project_ref);
      const v=await request(A,same,"same");
      await rejects(()=>store.send(v),"AUTH_GRANT");store.approve(v);await store.send(v);
      const charged=await request(B,M,"charged",{budget:{mode:"contributor_native",payer_ref:who(B).principal_ref,cap_micro_usd:"10",authorization_ref:"not_approved"}});
      store.approve(charged);await rejects(()=>store.send(charged),"BUDGET_REQUIRED");must(store.charges===0);
    }},
    {name:"causal order, cycle and depth limits",run:async()=>{
      const store=fake(),v=await deliver(store,M,A,"root");
      const late=await build(A,M,"root",4,v.message_id,{kind:"progress",text:"late"});store.approve(late);await rejects(()=>store.send(late),"STALE_OR_ORDER");
      const pin={capability_id:"x",revision:1,descriptor_sha256:await d()};
      const cycle=await request(A,M,"cycle",{purpose:"specialist",parent_thread:"root",capability:pin});store.approve(cycle);await rejects(()=>store.send(cycle),"CYCLE");
      await deliver(store,A,S,"child","specialist",{parent_thread:"root",capability:pin});
      const deep=await request(S,B,"deep",{purpose:"specialist",parent_thread:"child",capability:pin});store.approve(deep);await rejects(()=>store.send(deep),"DEPTH_OR_PARENT");
    }},
    {name:"review selects one retained revision, assignment, source and independent reviewer",run:async()=>{
      const store=fake(),accept=await deliver(store,M,A,"root"),c=await candidate();
      const prior=await hash(canonicalJson(c));
      const first=await reply(store,accept,A,M,{kind:"candidate",candidate:c});
      const select={kind:"review_request",candidate_sha256:prior};
      const verdict={kind:"review",candidate_sha256:prior,verdict:"reject",evidence_sha256:await d()};
      const review=await deliver(store,M,B,"independent","review",{input:c.source});
      await rejects(()=>reply(store,review,B,M,verdict),"REVIEW_SELECTION");
      const selection=await reply(store,review,M,B,select);
      const amended={...c,revision:2,parent_sha256:prior,source:await file("theorem corrected : True := True.intro\n")};
      const amendedDigest=await hash(canonicalJson(amended));
      await reply(store,first,A,M,{kind:"correction",candidate:amended});
      await rejects(()=>reply(store,selection,B,M,{...verdict,candidate_sha256:amendedDigest}),"REVIEW_SELECTION");
      await rejects(()=>reply(store,selection,M,B,verdict),"REVIEW_SELECTION");
      await rejects(()=>reply(store,selection,B,M,verdict,{actor:{...who(B),agent_ref:"other_agent"}}),"REVIEW_SELECTION");
      await reply(store,selection,B,M,verdict);
      eq(store.reviews.get("independent"),{candidate_sha256:prior,verdict:"reject"});

      const wrongSource=await deliver(store,M,B,"wrong_source","review",{input:amended.source});
      await rejects(()=>reply(store,wrongSource,M,B,select),"REVIEW_SELECTION");
      const unrelated={...scope,assignment_id:"another_assignment"};
      const other=await deliver(store,M,B,"other","review",{input:c.source},unrelated);
      await rejects(()=>reply(store,other,M,B,select),"REVIEW_SELECTION");
      const ownRoom=room("second_room",A.project_ref);
      const own=await deliver(store,M,ownRoom,"own_review","review",{input:c.source});
      const self=await reply(store,own,M,ownRoom,select);
      await rejects(()=>reply(store,self,ownRoom,M,verdict),"INDEPENDENT_REVIEW");
      must(store.reviews.size===1);
    }},
    {name:"both parties clarify before acceptance and the requester can cancel",run:async()=>{
      const store=fake(),start=await request(M,A,"question");
      store.approve(start);await store.send(start);
      const question=await reply(store,start,A,M,{kind:"clarify",text:"Which input?"});
      const answer=await reply(store,question,M,A,{kind:"clarify",text:"Use the selected source."});
      await rejects(()=>reply(store,answer,M,A,{kind:"accept",reason:"self"}),"NOT_ACCEPTED");
      await rejects(()=>reply(store,answer,M,A,{kind:"decline",reason:"self"}),"NOT_ACCEPTED");
      await reply(store,answer,A,M,{kind:"accept",reason:"understood"});
      const second=await request(M,A,"cancelled");
      store.approve(second);await store.send(second);
      const closed=await reply(store,second,M,A,{kind:"cancel",reason:"superseded"});
      await rejects(()=>reply(store,closed,A,M,{kind:"accept",reason:"late"}),"STALE_OR_ORDER");
    }},
    {name:"one specialist at a time and up to three distinct attempts per parent",run:async()=>{
      const store=fake();
      await deliver(store,M,A,"parent");
      const opts={purpose:"specialist",parent_thread:"parent",capability:{capability_id:"math",revision:1,descriptor_sha256:await d()}};
      const one=await request(A,S,"one",opts),two=await request(A,S,"two",opts);
      store.approve(one);
      const original=await store.send(one);
      eq(await store.send(one),original);
      store.approve(two);await rejects(()=>store.send(two),"FANOUT");
      await reply(store,one,S,A,{kind:"decline",reason:"unavailable"});
      await store.send(two);
      const started=await reply(store,two,S,A,{kind:"accept",reason:"available"});
      await reply(store,started,S,A,{kind:"candidate",candidate:await candidate(undefined,S,"support")});
      const three=await request(A,S,"three",opts);
      store.approve(three);await store.send(three);
      await reply(store,three,A,S,{kind:"cancel",reason:"resolved"});
      const four=await request(A,S,"four",opts);
      store.approve(four);await rejects(()=>store.send(four),"FANOUT");
    }},
    {name:"specialist lineage requires exact retained dependency",run:async()=>{
      const store=fake(),accept=await deliver(store,M,A,"root");
      const c=await candidate(undefined,A,"main_candidate",[{candidate_sha256:await d(),source:await file()}]);
      const delivery=await build(A,M,"root",3,accept.message_id,{kind:"candidate",candidate:c});
      store.approve(delivery);await rejects(()=>store.send(delivery),"SUPPORT_MISMATCH");
      await rejects(()=>parseEnvelope({...delivery,payload:{...delivery.payload,candidate:{...c,supporting_evidence:[c.supporting_evidence[0],c.supporting_evidence[0]]}}}));
    }},
    {name:"distinct verification receipt, no implied upstream acceptance",run:async()=>{
      const v=await build(A,M,"checked",2,"checked_1",{kind:"verification",candidate_sha256:await d(),checker_policy_sha256:await d(),receipt_sha256:await d(),evidence_class:"synthetic",verdict:"pass"},"verification");
      const r=await verifyEnvelope(v,hash);must(r.envelope.payload.evidence_class==="synthetic");
      await rejects(()=>parseEnvelope({...v,payload:{...v.payload,upstream_accepted:true}}));
    }},
  ];
}
