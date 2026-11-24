import {PublicKey} from '@solana/web3.js';
import {canonicalJson,requireCondition,validateText} from '../metadata.js';
import type {VerifiedReceipt,Lamports} from '../types.js';
import type {EconomyAssociationInput,EconomyBinding,EconomyPolicyInput,EconomyPolicy,EconomyProposal,EvaluatedEconomyProposal,FeeRecipient} from './types.js';
const actions=['report','propose_fee_claim','propose_fee_setup','propose_treasury_spend'];
export function onlyFields(value:object,fields:readonly string[],code:string):void{requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>fields.includes(key)),code);}
export function lamports(value:unknown):bigint {requireCondition(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&value.length<=80,'INVALID_LAMPORT_AMOUNT');return BigInt(value);}
export function amount(value:bigint):Lamports{return String(value) as Lamports;}
export function publicKey(value:string):string {let key:PublicKey;try{key=new PublicKey(value);}catch{throw new Error('INVALID_PUBLIC_KEY');}requireCondition(key.toBase58()===value&&!key.equals(PublicKey.default),'INVALID_PUBLIC_KEY');return value;}
export function frozen<T>(value:T):T {if(value!==null&&typeof value==='object'){for(const item of Object.values(value))frozen(item);Object.freeze(value);}return value;}
/** Caller supplies authenticated agent/owner and a server-verified launch; persist uniqueness atomically. */
export function registerEconomy(existing:readonly Readonly<EconomyBinding>[],input:EconomyAssociationInput,launch:VerifiedReceipt):Readonly<EconomyBinding>{
 onlyFields(input,['economy_id','agent_id','owner_id','launch_intent_id'],'UNKNOWN_ASSOCIATION_FIELD');
 for(const value of Object.values(input))validateText(value,160,'INVALID_ECONOMY_ID');
 requireCondition(launch.status==='finalized','UNFINALIZED_LAUNCH');requireCondition(input.launch_intent_id===launch.intent_id,'LAUNCH_INTENT_MISMATCH');
 requireCondition(Number.isSafeInteger(launch.slot)&&launch.slot>=0,'INVALID_LAUNCH_SLOT');publicKey(launch.mint_address);publicKey(launch.creator_public_key);
 requireCondition(['mainnet-beta','devnet'].includes(launch.network)&&!!launch.genesis_hash&&!!launch.transaction_signature,'INVALID_LAUNCH_RECEIPT');
 const binding:EconomyBinding={...input,network:launch.network,genesis_hash:launch.genesis_hash,mint_address:launch.mint_address,creator_public_key:launch.creator_public_key,launch_signature:launch.transaction_signature,launch_slot:launch.slot};
 const conflicts=existing.filter(item=>item.economy_id===input.economy_id||item.agent_id===input.agent_id||(item.network===launch.network&&item.mint_address===launch.mint_address));
 if(conflicts.length){requireCondition(conflicts.length===1&&canonicalJson(conflicts[0])===canonicalJson(binding),'ECONOMY_ASSOCIATION_CONFLICT');return conflicts[0]!;}
 return frozen(binding);
}
export function validateRecipients(recipients:readonly FeeRecipient[],expectedTotal?:number):void {
 requireCondition(recipients.length<=10,'TOO_MANY_RECIPIENTS');const seen=new Set<string>();let sum=0;
 for(const recipient of recipients){onlyFields(recipient,['address','share_bps'],'UNKNOWN_RECIPIENT_FIELD');publicKey(recipient.address);requireCondition(!seen.has(recipient.address),'DUPLICATE_RECIPIENT');seen.add(recipient.address);requireCondition(Number.isSafeInteger(recipient.share_bps)&&recipient.share_bps>0&&recipient.share_bps<=10000,'INVALID_RECIPIENT_SHARE');sum+=recipient.share_bps;}
 if(expectedTotal!==undefined)requireCondition(sum===expectedTotal,'INCOMPLETE_RECIPIENT_ALLOCATION');
}
export function createEconomyPolicy(input:EconomyPolicyInput):Readonly<EconomyPolicy>{
 onlyFields(input,['economy_id','owner_id','version','fee_basis','basis_confirmed','approval_status','platform_recipient','other_recipients','allowed_actions','max_proposal_lamports','max_reserved_lamports','revoked','platform_share_bps','execution_mode'],'UNKNOWN_POLICY_FIELD');
 const supplied=input as EconomyPolicy;requireCondition(supplied.platform_share_bps===undefined||supplied.platform_share_bps===2000,'INVALID_PLATFORM_SHARE');requireCondition(supplied.execution_mode===undefined||supplied.execution_mode==='human_review_only','INVALID_EXECUTION_MODE');
 validateText(input.economy_id,160,'INVALID_ECONOMY_ID');validateText(input.owner_id,160,'INVALID_OWNER_ID');requireCondition(Number.isSafeInteger(input.version)&&input.version>0,'INVALID_POLICY_VERSION');
 const policy:EconomyPolicy={...structuredClone(input),fee_basis:input.fee_basis??'creator_fees_received',basis_confirmed:input.basis_confirmed??false,approval_status:input.approval_status??'proposed',platform_recipient:input.platform_recipient??null,other_recipients:structuredClone(input.other_recipients??[]),allowed_actions:[...(input.allowed_actions??['report'])],max_proposal_lamports:input.max_proposal_lamports??'0',max_reserved_lamports:input.max_reserved_lamports??'0',revoked:input.revoked??false,platform_share_bps:2000,execution_mode:'human_review_only'};
 requireCondition(['creator_fees_received','total_trading_fees'].includes(policy.fee_basis),'INVALID_FEE_BASIS');requireCondition(['proposed','owner_approved'].includes(policy.approval_status),'INVALID_POLICY_APPROVAL');requireCondition(typeof policy.revoked==='boolean'&&typeof policy.basis_confirmed==='boolean','INVALID_POLICY_FLAGS');
 if(policy.platform_recipient)publicKey(policy.platform_recipient);validateRecipients(policy.other_recipients);
 requireCondition(!policy.other_recipients.some(recipient=>recipient.address===policy.platform_recipient),'DUPLICATE_RECIPIENT');
 const feeCapable=policy.allowed_actions.some(action=>action==='propose_fee_setup'||action==='propose_fee_claim');
 if(feeCapable){requireCondition(policy.platform_recipient!==null,'PLATFORM_RECIPIENT_REQUIRED');validateRecipients([{address:policy.platform_recipient,share_bps:policy.platform_share_bps},...policy.other_recipients],10000);}
 requireCondition(policy.allowed_actions.every(action=>actions.includes(action))&&new Set(policy.allowed_actions).size===policy.allowed_actions.length,'INVALID_ALLOWED_ACTIONS');
 requireCondition(lamports(policy.max_proposal_lamports)<=lamports(policy.max_reserved_lamports),'INVALID_POLICY_BUDGET');
 return frozen(policy);
}
export function policyBlockReason(binding:EconomyBinding,policy:EconomyPolicy):string|null {
 if(binding.economy_id!==policy.economy_id||binding.owner_id!==policy.owner_id)return 'POLICY_IDENTITY_MISMATCH';
 if(policy.revoked)return 'POLICY_REVOKED';if(policy.approval_status!=='owner_approved')return 'OWNER_APPROVAL_REQUIRED';
 if(!policy.basis_confirmed)return 'FEE_BASIS_CONFIRMATION_REQUIRED';if(policy.fee_basis!=='creator_fees_received')return 'UNSUPPORTED_FEE_BASIS';return null;
}
export function evaluateEconomyProposal(binding:EconomyBinding,policy:EconomyPolicy,proposal:EconomyProposal,audit:readonly EvaluatedEconomyProposal[]):Readonly<EvaluatedEconomyProposal>{
 onlyFields(proposal,['proposal_id','agent_id','owner_id','economy_id','policy_version','action','requested_lamports','reason'],'UNKNOWN_PROPOSAL_FIELD');
 validateText(proposal.proposal_id,160,'INVALID_PROPOSAL_ID');validateText(proposal.reason,2000,'INVALID_PROPOSAL_REASON');const requested=lamports(proposal.requested_lamports);
 let reason=policyBlockReason(binding,policy);
 if(!reason&&(proposal.economy_id!==binding.economy_id||proposal.agent_id!==binding.agent_id||proposal.owner_id!==binding.owner_id))reason='PROPOSAL_IDENTITY_MISMATCH';
 if(!reason&&proposal.policy_version!==policy.version)reason='POLICY_VERSION_MISMATCH';
 if(!reason&&!policy.allowed_actions.includes(proposal.action))reason='ACTION_NOT_PERMITTED';
 if(!reason&&proposal.action==='report'&&requested!==0n)reason='REPORT_CANNOT_REQUEST_SPEND';
 if(!reason&&requested>lamports(policy.max_proposal_lamports))reason='PROPOSAL_BUDGET_EXCEEDED';
 const reserved=audit.filter(item=>item.status==='eligible_human_review'&&item.proposal.economy_id===binding.economy_id&&item.proposal.policy_version===policy.version&&item.proposal.proposal_id!==proposal.proposal_id).reduce((sum,item)=>sum+lamports(item.proposal.requested_lamports),0n);
 if(!reason&&reserved+requested>lamports(policy.max_reserved_lamports))reason='RESERVED_BUDGET_EXCEEDED';
 return frozen({proposal:structuredClone(proposal),status:reason?'blocked':'eligible_human_review',reason:reason??'HUMAN_REVIEW_REQUIRED',can_sign:false,can_execute:false});
}
export function recordEconomyProposal(audit:readonly EvaluatedEconomyProposal[],item:EvaluatedEconomyProposal):readonly Readonly<EvaluatedEconomyProposal>[] {
 const previous=audit.find(entry=>entry.proposal.proposal_id===item.proposal.proposal_id);
 if(previous){requireCondition(canonicalJson(previous)===canonicalJson(item),'PROPOSAL_CONFLICT');return audit;}
 return frozen([...audit,frozen(structuredClone(item))]);
}
