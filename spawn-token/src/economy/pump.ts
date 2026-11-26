import {PublicKey,type TransactionInstruction} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {PUMP_SDK,feeSharingConfigPda,canonicalPumpPoolPda,type SharingConfig} from '@pump-fun/pump-sdk';
import {canonicalJson,requireCondition,sha256,validateText} from '../metadata.js';
import {normalizeEconomyPolicy,frozen,policyBlockReason,publicKey,validateRecipients} from './policy.js';
import type {EconomyBinding,EconomyPolicy,EconomyChainState,InstructionDto,UnsignedEconomyPlan,FeeRecipient} from './types.js';
export function instructionDto(instruction:TransactionInstruction):InstructionDto{return {program_id:instruction.programId.toBase58(),accounts:instruction.keys.map(key=>({public_key:key.pubkey.toBase58(),is_signer:key.isSigner,is_writable:key.isWritable})),data_base64:instruction.data.toString('base64')};}
/** Solana message privileges are the union across all occurrences of an account, including the fee payer. */
function messageInstructionDtos(instructions:readonly TransactionInstruction[],feePayer:string):InstructionDto[]{
 const privileges=new Map<string,{is_signer:boolean;is_writable:boolean}>([[feePayer,{is_signer:true,is_writable:true}]]);
 for(const instruction of instructions)for(const key of instruction.keys){const address=key.pubkey.toBase58(),previous=privileges.get(address);privileges.set(address,{is_signer:key.isSigner||previous?.is_signer===true,is_writable:key.isWritable||previous?.is_writable===true});}
 return instructions.map(instruction=>{const dto=instructionDto(instruction);return {...dto,accounts:dto.accounts.map(account=>({...account,...privileges.get(account.public_key)!}))};});
}
export function policyRecipients(policy:EconomyPolicy):readonly FeeRecipient[]{
 requireCondition(policy.platform_recipient!==null,'PLATFORM_RECIPIENT_REQUIRED');const recipients=[{address:policy.platform_recipient,share_bps:policy.platform_share_bps},...policy.other_recipients];validateRecipients(recipients,10000);return recipients;
}
export async function distributionInstructions(mintAddress:string,feePayer:string,phase:'bonding_curve'|'graduated',recipients:readonly FeeRecipient[]):Promise<InstructionDto[]>{
 const mint=new PublicKey(mintAddress),payer=new PublicKey(feePayer),config=feeSharingConfigPda(mint);
 const sharing:SharingConfig={version:2,mint,admin:payer,adminRevoked:true,shareholders:recipients.map(recipient=>({address:new PublicKey(recipient.address),shareBps:recipient.share_bps}))};
 const instructions:TransactionInstruction[]=[];
 if(phase==='graduated')instructions.push(await PUMP_SDK.transferCreatorFeesToPumpV2({payer,mint,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID}));
 instructions.push(await PUMP_SDK.distributeCreatorFeesV2({mint,sharingConfig:sharing,sharingConfigAddress:config,quoteMint:NATIVE_MINT,payer,shouldInitializeAta:false,quoteTokenProgram:TOKEN_PROGRAM_ID}));
 return messageInstructionDtos(instructions,feePayer);
}
/** Offline instruction-only builder. State must come from a backend-controlled finalized resolver, never client/agent claims. */
export async function buildUnsignedEconomyPlan(binding:EconomyBinding,policy:EconomyPolicy,state:EconomyChainState,request:{plan_id:string;fee_payer:string;action:UnsignedEconomyPlan['action']}):Promise<Readonly<UnsignedEconomyPlan>>{
 binding=structuredClone(binding);policy=normalizeEconomyPolicy(policy);state=structuredClone(state);request=structuredClone(request);
 requireCondition(policyBlockReason(binding,policy)===null,'INACTIVE_ECONOMY_POLICY');validateText(request.plan_id,160,'INVALID_PLAN_ID');publicKey(request.fee_payer);
 requireCondition(request.action==='setup_fee_sharing'||request.action==='distribute_creator_fees','UNSUPPORTED_ECONOMY_ACTION');
 requireCondition(policy.allowed_actions.includes(request.action==='setup_fee_sharing'?'propose_fee_setup':'propose_fee_claim'),'ACTION_NOT_PERMITTED');
 requireCondition(state.network===binding.network&&state.genesis_hash===binding.genesis_hash&&state.mint_address===binding.mint_address,'CHAIN_STATE_IDENTITY_MISMATCH');
 requireCondition(Number.isSafeInteger(state.slot)&&state.slot>=binding.launch_slot,'STALE_CHAIN_STATE');requireCondition(['bonding_curve','graduated'].includes(state.phase),'INVALID_ECONOMY_PHASE');
 requireCondition(state.holder_rewards===false&&state.cashback===false&&state.mayhem===false&&state.quote_mint===NATIVE_MINT.toBase58(),'UNSUPPORTED_ECONOMY_COIN_MODE');
 const mint=new PublicKey(binding.mint_address),sharingAddress=feeSharingConfigPda(mint).toBase58(),recipients=policyRecipients(policy);
 requireCondition(state.creator_public_key===(state.sharing_config?sharingAddress:binding.creator_public_key),'CHAIN_CREATOR_MISMATCH');
 if(state.sharing_config)requireCondition(state.sharing_config.status==='active','SHARING_CONFIG_NOT_ACTIVE');
 let instructions:InstructionDto[];const warnings:string[]=[];
 if(request.action==='setup_fee_sharing'){
  requireCondition(state.sharing_config?.admin_revoked!==true,'SHARING_ADMIN_REVOKED');
  requireCondition(!state.sharing_config||state.sharing_config.version!==1,'LEGACY_SHARING_CONFIG_UNSUPPORTED');
  const authority=state.sharing_config?.admin??binding.creator_public_key;requireCondition(authority===binding.creator_public_key,'SHARING_ADMIN_NOT_OWNER_CREATOR');
  const current=state.sharing_config?.shareholders??[{address:binding.creator_public_key,share_bps:10000}];validateRecipients(current,10000);
  const result:TransactionInstruction[]=[];
  if(!state.sharing_config)result.push(await PUMP_SDK.createFeeSharingConfig({creator:new PublicKey(authority),mint,pool:state.phase==='graduated'?canonicalPumpPoolPda(mint):null}));
  result.push(await PUMP_SDK.updateFeeSharesV2({authority:new PublicKey(authority),mint,currentShareholders:current.map(recipient=>new PublicKey(recipient.address)),newShareholders:recipients.map(recipient=>({address:new PublicKey(recipient.address),shareBps:recipient.share_bps})),quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID}));
  instructions=messageInstructionDtos(result,request.fee_payer);warnings.push('Final V2 shares permanently revoke fee-sharing admin updates. Pending creator fees are swept to the current (old) shareholders before new shares apply. Setup requires a fresh human review, wallet signatures, live simulation and actual rent/network-fee quote.');
 }else{
  requireCondition(state.sharing_config!==null,'SHARING_CONFIG_REQUIRED');requireCondition(state.sharing_config.version!==1,'LEGACY_SHARING_CONFIG_UNSUPPORTED');
  requireCondition(canonicalJson(state.sharing_config.shareholders)===canonicalJson(recipients),'ONCHAIN_SHARE_POLICY_MISMATCH');
  instructions=await distributionInstructions(binding.mint_address,request.fee_payer,state.phase,recipients);warnings.push('Distribution is permissionless on chain but SPAWN agents only propose it. A human-owned wallet must review, sign and pay the actual network fee. Vault rent and provider dust are excluded from fees actually received.');
 }
 const unsigned:Omit<UnsignedEconomyPlan,'plan_hash'>={plan_id:request.plan_id,economy_id:binding.economy_id,agent_id:binding.agent_id,owner_id:binding.owner_id,policy_version:policy.version,network:binding.network,genesis_hash:binding.genesis_hash,mint_address:binding.mint_address,fee_payer:request.fee_payer,action:request.action,phase:state.phase,observed_slot:state.slot,instructions,recipient_shares:structuredClone(recipients),sharing_config_address:sharingAddress,requires_human_review:true,can_sign:false,can_execute:false,irreversible_admin_revocation:request.action==='setup_fee_sharing',warnings};
 return frozen({...unsigned,plan_hash:await sha256(canonicalJson(unsigned))});
}
