/**
 * Portable research exchange wire contract. Validation is not authorization.
 * The native host resolves actor/room aliases, grants, budget and storage.
 * No code in this module creates an effect, a grant or a payment.
 */
export const VERSION = "spawn.research.exchange.v1";
export const MAX_WIRE_BYTES = 32768;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const fail = (code) => { throw new Error(code); };
const check = (ok, code = "RESEARCH_INVALID") => { if (!ok) fail(code); };
const object = (v, keys) => {
  check(v !== null && typeof v === "object" && !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v)));
  const own = Reflect.ownKeys(v);
  check(own.length === keys.length && keys.every(k =>
    Object.hasOwn(v,k) && Object.getOwnPropertyDescriptor(v,k).enumerable &&
    "value" in Object.getOwnPropertyDescriptor(v,k)));
};
const id = v => check(typeof v === "string" && ID.test(v));
const digest = v => check(typeof v === "string" && DIGEST.test(v));
const integer = (v,min=0) => check(Number.isSafeInteger(v) && v >= min);
const one = (v, allowed) => check(allowed.includes(v));
const str = (v, max) => {
  check(typeof v === "string" && v.length > 0 && v.length <= max &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v));
  check(utf8Length(v) <= max);
};
// Match UTF-8 octets without relying on platform-dependent normalization.
function utf8Length(s) {
  let n=0;
  for (const c of s) { const p=c.codePointAt(0); n+=p<128?1:p<2048?2:p<65536?3:4; }
  return n;
}
const nullable = (v, fn) => { if (v !== null) fn(v); };
const scope = v => { object(v, ["agenda_id","question_id","assignment_id"]); Object.values(v).forEach(id); };
const endpoint = v => { object(v, ["room_ref","project_ref"]); id(v.room_ref); id(v.project_ref); };
const actor = v => {
  object(v, ["principal_ref","installation_ref","agent_ref"]);
  id(v.principal_ref); nullable(v.installation_ref,id); nullable(v.agent_ref,id);
};
const path = v => {
  str(v,512);
  check(!v.startsWith("/") && !v.includes("\\") && !/[\x00-\x1f\x7f]/.test(v) &&
    v.split("/").every(s => s && s !== "." && s !== ".." && s.toLowerCase() !== ".git"));
};
function source(v) {
  if (v?.kind === "file") {
    object(v, ["kind","manifest_ref","manifest_sha256","artifact_ref","sha256","size_bytes"]);
    id(v.manifest_ref); digest(v.manifest_sha256); id(v.artifact_ref); digest(v.sha256);
    integer(v.size_bytes,1); check(v.size_bytes <= 5*1024*1024);
  } else {
    object(v, ["kind","repo_ref","base","commit","tree","files"]); one(v.kind,["git"]);
    id(v.repo_ref); [v.base,v.commit,v.tree].forEach(s => check(typeof s==="string" && GIT.test(s)));
    check(v.base.length===v.commit.length && v.commit.length===v.tree.length);
    check(Array.isArray(v.files) && v.files.length>0 && v.files.length<=32);
    for (const f of v.files) {
      object(f,["path","sha256","size_bytes"]); path(f.path); digest(f.sha256);
      integer(f.size_bytes,1); check(f.size_bytes<=5*1024*1024);
    }
    check(new Set(v.files.map(f=>f.path)).size===v.files.length);
  }
}
function budget(v) {
  object(v,["mode","payer_ref","cap_micro_usd","authorization_ref"]);
  one(v.mode,["external_self","contributor_native","room_review","requester_native"]);
  id(v.payer_ref);
  if (v.mode==="external_self") check(v.cap_micro_usd===null && v.authorization_ref===null);
  else {
    check(typeof v.cap_micro_usd==="string" && /^[1-9][0-9]{0,15}$/.test(v.cap_micro_usd));
    id(v.authorization_ref);
  }
}
function capabilityPin(v) {
  object(v,["capability_id","revision","descriptor_sha256"]);
  id(v.capability_id); integer(v.revision,1); digest(v.descriptor_sha256);
}
export function parseCapability(raw) {
  const v = wire(raw);
  object(v,["version","capability_id","revision","input_schema_sha256","output_schema_sha256",
    "disclosure_policy_sha256","visibility","available","budget_modes"]);
  check(v.version===VERSION,"RESEARCH_VERSION");
  id(v.capability_id); integer(v.revision,1);
  [v.input_schema_sha256,v.output_schema_sha256,v.disclosure_policy_sha256].forEach(digest);
  one(v.visibility,["listed","invite_only"]); check(typeof v.available==="boolean");
  check(Array.isArray(v.budget_modes)&&v.budget_modes.length>0&&v.budget_modes.length<=4&&
    new Set(v.budget_modes).size===v.budget_modes.length);
  v.budget_modes.forEach(m=>one(m,["external_self","contributor_native","room_review","requester_native"]));
  return v;
}
function candidate(v) {
  object(v,["candidate_id","revision","parent_sha256","statement_sha256","producer_ref","source","checker_policy_sha256","supporting_evidence"]);
  id(v.candidate_id); integer(v.revision,1); nullable(v.parent_sha256,digest);
  check((v.revision===1)===(v.parent_sha256===null));
  digest(v.statement_sha256); id(v.producer_ref); source(v.source); digest(v.checker_policy_sha256);
  // Explicit selected dependencies; a locator or digest grants no read access.
  check(Array.isArray(v.supporting_evidence)&&v.supporting_evidence.length<=8);
  for(const e of v.supporting_evidence) {
    object(e,["candidate_sha256","source"]);
    digest(e.candidate_sha256); source(e.source);
  }
  check(new Set(v.supporting_evidence.map(e=>e.candidate_sha256)).size===v.supporting_evidence.length);
}
function payload(v) {
  switch(v?.kind) {
    case "request":
      object(v,["kind","purpose","question_sha256","input","capability","budget","parent_thread"]);
      one(v.purpose,["research","specialist","review"]); digest(v.question_sha256);
      nullable(v.input,source); nullable(v.capability,capabilityPin); budget(v.budget); nullable(v.parent_thread,id);
      check(v.purpose!=="specialist" || (v.capability!==null && v.parent_thread!==null)); break;
    case "accept": case "decline": case "cancel": case "withdraw":
      object(v,["kind","reason"]); str(v.reason,2048); break;
    case "clarify": case "progress":
      object(v,["kind","text"]); str(v.text,2048); break;
    case "candidate": case "correction":
      object(v,["kind","candidate"]); candidate(v.candidate);
      if(v.kind==="correction") check(v.candidate.revision>1); break;
    case "review_request":
      object(v,["kind","candidate_sha256"]); digest(v.candidate_sha256); break;
    case "review":
      object(v,["kind","candidate_sha256","verdict","evidence_sha256"]);
      digest(v.candidate_sha256); one(v.verdict,["approve","reject","inconclusive"]); digest(v.evidence_sha256); break;
    case "verify":
      object(v,["kind","candidate_sha256","checker_policy_sha256"]); digest(v.candidate_sha256); digest(v.checker_policy_sha256); break;
    case "verification":
      object(v,["kind","candidate_sha256","checker_policy_sha256","receipt_sha256","evidence_class","verdict"]);
      [v.candidate_sha256,v.checker_policy_sha256,v.receipt_sha256].forEach(digest);
      one(v.evidence_class,["synthetic","local_checker"]); one(v.verdict,["pass","fail","unknown"]); break;
    default: fail("RESEARCH_KIND");
  }
}
/** Canonical wire values: plain JSON, safe integers, Unicode scalar strings,
 * lexicographically sorted object keys, no accessors, undefined or cycles.
 * Array ordering is semantic. No Unicode normalization. */
export function canonicalJson(raw) {
  function encode(v,depth) {
    check(depth<=16,"RESEARCH_DEPTH");
    if(v===null || typeof v==="boolean") return JSON.stringify(v);
    if(typeof v==="number") { integer(v); return JSON.stringify(v); }
    if(typeof v==="string") {
      check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v));
      check(v.length<=MAX_WIRE_BYTES); return JSON.stringify(v);
    }
    check(v!==null&&typeof v==="object");
    if(Array.isArray(v)) {
      check(v.length<=128 && Reflect.ownKeys(v).length===v.length+1);
      const parts=[];
      for(let i=0;i<v.length;i++){
        const d=Object.getOwnPropertyDescriptor(v,String(i)); check(d&&"value" in d&&d.enumerable);
        parts.push(encode(d.value,depth+1));
      }
      return "["+parts.join(",")+"]";
    }
    check([Object.prototype,null].includes(Object.getPrototypeOf(v)));
    const keys=Reflect.ownKeys(v); check(keys.length<=64&&keys.every(k=>typeof k==="string"&&ID.test(k)));
    return "{"+keys.sort().map(k=>{
      const d=Object.getOwnPropertyDescriptor(v,k); check(d&&"value" in d&&d.enumerable);
      return JSON.stringify(k)+":"+encode(d.value,depth+1);
    }).join(",")+"}";
  }
  const out=encode(raw,0); check(utf8Length(out)<=MAX_WIRE_BYTES,"RESEARCH_SIZE"); return out;
}
function wire(raw) { return JSON.parse(canonicalJson(raw)); }
export function parseEnvelope(raw) {
  const v=wire(raw);
  object(v,["version","assignment","source","target","actor","message_id","thread_id","reply_to",
    "sequence","original_key","grant","disclosure","expires_at_ms","payload","payload_sha256"]);
  check(v.version===VERSION,"RESEARCH_VERSION"); scope(v.assignment); endpoint(v.source); endpoint(v.target); actor(v.actor);
  check(v.source.room_ref!==v.target.room_ref||v.source.project_ref!==v.target.project_ref);
  [v.message_id,v.thread_id,v.original_key].forEach(id); nullable(v.reply_to,id); integer(v.sequence,1);
  check(v.payload?.kind==="request" ? v.sequence===1&&v.reply_to===null : v.sequence>1&&v.reply_to!==null);
  object(v.grant,["ref","epoch"]); id(v.grant.ref); integer(v.grant.epoch,1);
  object(v.disclosure,["decision_ref","policy_sha256","purpose","recipient"]);
  id(v.disclosure.decision_ref); digest(v.disclosure.policy_sha256); one(v.disclosure.purpose,["research","specialist","review","verification"]);
  endpoint(v.disclosure.recipient); check(canonicalJson(v.target)===canonicalJson(v.disclosure.recipient),"RESEARCH_RECIPIENT");
  integer(v.expires_at_ms,1); payload(v.payload); digest(v.payload_sha256);
  if(v.payload.kind==="request") check(v.disclosure.purpose===v.payload.purpose);
  return v;
}
/** The caller supplies SHA-256 from an admitted platform implementation.
 * It must hash the exact UTF-8 input and return a sha256: prefix. */
export async function verifyEnvelope(raw, sha256) {
  const envelope=parseEnvelope(raw);
  const actual=await sha256(canonicalJson(envelope.payload));
  digest(actual); check(actual===envelope.payload_sha256,"RESEARCH_PAYLOAD_DIGEST");
  const envelope_sha256=await sha256(canonicalJson(envelope)); digest(envelope_sha256);
  return {envelope,envelope_sha256};
}
/** Idempotency is scoped to actor, source and assignment, not destination or
 * user-controlled message ID. Native authority must bind aliases to principals. */
export function originalScope(v) {
  return canonicalJson({version:VERSION,assignment:v.assignment,source:v.source,
    principal_ref:v.actor.principal_ref,original_key:v.original_key});
}
