export const VERSION: "spawn.research.exchange.v1";
export const MAX_WIRE_BYTES: number;
export type Digest = `sha256:${string}`;
export type Scope = { agenda_id:string; question_id:string; assignment_id:string };
export type Endpoint = { room_ref:string; project_ref:string };
export type Actor = { principal_ref:string; installation_ref:string|null; agent_ref:string|null };
export type Source = { kind:"file"; manifest_ref:string; manifest_sha256:Digest; artifact_ref:string; sha256:Digest; size_bytes:number } |
  { kind:"git"; repo_ref:string; base:string; commit:string; tree:string; files:{path:string;sha256:Digest;size_bytes:number}[] };
export type BudgetMode = "external_self"|"contributor_native"|"room_review"|"requester_native";
export type Budget = { mode:"external_self";payer_ref:string;cap_micro_usd:null;authorization_ref:null } |
 { mode:Exclude<BudgetMode,"external_self">;payer_ref:string;cap_micro_usd:string;authorization_ref:string };
export type CapabilityPin = { capability_id:string; revision:number; descriptor_sha256:Digest };
export type Capability = { version:typeof VERSION; capability_id:string;revision:number;input_schema_sha256:Digest;output_schema_sha256:Digest;
 disclosure_policy_sha256:Digest;visibility:"listed"|"invite_only";available:boolean;budget_modes:BudgetMode[] };
export type Candidate = { candidate_id:string;revision:number;parent_sha256:Digest|null;statement_sha256:Digest;producer_ref:string;source:Source;checker_policy_sha256:Digest;supporting_evidence:{candidate_sha256:Digest;source:Source}[] };
export type Payload =
 | {kind:"request";purpose:"research"|"specialist"|"review";question_sha256:Digest;input:Source|null;capability:CapabilityPin|null;budget:Budget;parent_thread:string|null}
 | {kind:"accept"|"decline"|"cancel"|"withdraw";reason:string}
 | {kind:"clarify"|"progress";text:string}
 | {kind:"candidate"|"correction";candidate:Candidate}
 | {kind:"review_request";candidate_sha256:Digest}
 | {kind:"review";candidate_sha256:Digest;verdict:"approve"|"reject"|"inconclusive";evidence_sha256:Digest}
 | {kind:"verify";candidate_sha256:Digest;checker_policy_sha256:Digest}
 | {kind:"verification";candidate_sha256:Digest;checker_policy_sha256:Digest;receipt_sha256:Digest;evidence_class:"synthetic"|"local_checker";verdict:"pass"|"fail"|"unknown"};
export type Envelope = {version:typeof VERSION;assignment:Scope;source:Endpoint;target:Endpoint;actor:Actor;message_id:string;thread_id:string;
 reply_to:string|null;sequence:number;original_key:string;grant:{ref:string;epoch:number};
 disclosure:{decision_ref:string;policy_sha256:Digest;purpose:"research"|"specialist"|"review"|"verification";recipient:Endpoint};
 expires_at_ms:number;payload:Payload;payload_sha256:Digest};
export type Hash = (text:string)=>Digest|Promise<Digest>;
export function canonicalJson(value:unknown):string;
export function parseCapability(value:unknown):Capability;
export function parseEnvelope(value:unknown):Envelope;
export function verifyEnvelope(value:unknown,sha256:Hash):Promise<{envelope:Envelope;envelope_sha256:Digest}>;
export function originalScope(value:Envelope):string;
