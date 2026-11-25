import {canonicalJson,requireCondition,validateText} from '../metadata.js';
import {amount,lamports,frozen,policyBlockReason,normalizeEconomyPolicy,onlyFields} from './policy.js';
import type {EconomyBinding,EconomyPolicy,EconomyLedger,FinalizedFeeReceipt,EvaluatedEconomyProposal,EconomyTreasuryReport} from './types.js';
export function createEconomyLedger(binding:EconomyBinding,policy:EconomyPolicy):Readonly<EconomyLedger>{
 policy=normalizeEconomyPolicy(policy);requireCondition(policyBlockReason(binding,policy)===null,'INACTIVE_ECONOMY_POLICY');
 return frozen({binding:structuredClone(binding),policy:structuredClone(policy),receipts:[]});
}
/** Only server-verified source receipts belong here. Durable atomic uniqueness remains a backend responsibility. */
export function reconcileEconomyFee(ledger:EconomyLedger,receipt:FinalizedFeeReceipt):Readonly<EconomyLedger>{
 onlyFields(receipt,['receipt_id','economy_id','network','genesis_hash','mint_address','transaction_signature','slot','event_index','status','source','fee_basis','eligible_received_lamports','platform_received_lamports','source_distributed_lamports','source_dust_lamports','policy_version'],'UNKNOWN_FEE_RECEIPT_FIELD');
 validateText(receipt.receipt_id,300,'INVALID_RECEIPT_ID');validateText(receipt.transaction_signature,160,'INVALID_RECEIPT_SIGNATURE');
 requireCondition(receipt.status==='finalized'&&receipt.source==='pump_shared_creator_distribution'&&receipt.fee_basis==='creator_fees_received','UNVERIFIED_OR_UNATTRIBUTABLE_FEE');
 const b=ledger.binding;requireCondition(receipt.economy_id===b.economy_id&&receipt.network===b.network&&receipt.genesis_hash===b.genesis_hash&&receipt.mint_address===b.mint_address&&receipt.policy_version===ledger.policy.version,'FEE_IDENTITY_MISMATCH');
 requireCondition(Number.isSafeInteger(receipt.slot)&&receipt.slot>=b.launch_slot&&Number.isSafeInteger(receipt.event_index)&&receipt.event_index>=0,'INVALID_FEE_COORDINATES');
 const previous=ledger.receipts.find(item=>item.receipt_id===receipt.receipt_id);
 if(previous){requireCondition(canonicalJson(previous)===canonicalJson(receipt),'FEE_RECEIPT_CONFLICT');return ledger;}
 const received=lamports(receipt.eligible_received_lamports),platform=lamports(receipt.platform_received_lamports),distributed=lamports(receipt.source_distributed_lamports),dust=lamports(receipt.source_dust_lamports);
 requireCondition(platform<=received&&received+dust===distributed,'INCONSISTENT_FEE_AMOUNTS');
 requireCondition(!ledger.receipts.some(item=>item.network===receipt.network&&item.transaction_signature===receipt.transaction_signature&&item.event_index===receipt.event_index),'FEE_SOURCE_ALREADY_ACCOUNTED');
 return frozen({...ledger,receipts:[...ledger.receipts,frozen(structuredClone(receipt))]});
}
export function economyTreasuryReport(ledger:EconomyLedger,audit:readonly EvaluatedEconomyProposal[]):Readonly<EconomyTreasuryReport>{
 const eligible=ledger.receipts.reduce((sum,r)=>sum+lamports(r.eligible_received_lamports),0n),received=ledger.receipts.reduce((sum,r)=>sum+lamports(r.platform_received_lamports),0n);
 const scaled=eligible*BigInt(ledger.policy.platform_share_bps),entitlement=scaled/10000n,difference=entitlement-received;
 const proposals=audit.filter(item=>item.proposal.economy_id===ledger.binding.economy_id);
 return frozen({economy_id:ledger.binding.economy_id,agent_id:ledger.binding.agent_id,owner_id:ledger.binding.owner_id,network:ledger.binding.network,mint_address:ledger.binding.mint_address,fee_basis:ledger.policy.fee_basis,platform_share_bps:2000,receipt_count:ledger.receipts.length,eligible_received_lamports:amount(eligible),platform_entitlement_lamports:amount(entitlement),platform_received_lamports:amount(received),platform_outstanding_lamports:amount(difference>0n?difference:0n),platform_overpaid_lamports:amount(difference<0n?-difference:0n),remaining_received_lamports:amount(eligible-received),fractional_entitlement_numerator:amount(scaled%10000n),fractional_entitlement_denominator:10000,source_dust_lamports:amount(ledger.receipts.reduce((sum,r)=>sum+lamports(r.source_dust_lamports),0n)),remaining_allocation:'owner_policy_only',proposal_count:proposals.length,blocked_proposal_count:proposals.filter(item=>item.status==='blocked').length,execution_mode:'human_review_only'});
}
