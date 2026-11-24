import {describe, expect, it} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import {NATIVE_MINT} from '@solana/spl-token';
import {createEconomyLedger, createEconomyPolicy, economyTreasuryReport} from '../src/economy-policy.js';
import {buildUnsignedEconomyPlan} from '../src/economy/pump.js';
import type {EconomyBinding, EconomyChainState, EconomyPolicy, EconomyPolicyInput} from '../src/economy/types.js';
import {MINT, WALLET} from './fixtures.js';

const platform = new PublicKey(new Uint8Array(32).fill(13)).toBase58();
const binding: EconomyBinding = {
  economy_id: 'economy_01', agent_id: 'agent_01', owner_id: 'owner_01', launch_intent_id: 'launch_01',
  network: 'devnet', genesis_hash: 'fixture_genesis', mint_address: MINT, creator_public_key: WALLET,
  launch_signature: 'fixture-launch', launch_slot: 42,
};
const feeInput: EconomyPolicyInput = {
  economy_id: binding.economy_id, owner_id: binding.owner_id, version: 1,
  fee_basis: 'creator_fees_received', basis_confirmed: true, approval_status: 'owner_approved',
  platform_recipient: platform, other_recipients: [{address: WALLET, share_bps: 8000}],
  allowed_actions: ['propose_fee_setup', 'propose_fee_claim'],
  max_proposal_lamports: '10000', max_reserved_lamports: '10000',
};
const chain: EconomyChainState = {
  ...binding, slot: 45, phase: 'bonding_curve', holder_rewards: false, cashback: false, mayhem: false,
  quote_mint: NATIVE_MINT.toBase58(), sharing_config: null,
};
const retained = (overrides: Partial<EconomyPolicy>): EconomyPolicy => ({
  ...createEconomyPolicy(feeInput), ...overrides,
});

describe('economy policy recipient allocation', () => {
  it.each([0, 7500, 9000])('rejects an incomplete new fee policy (%s other basis points)', (bps) => {
    const other_recipients = bps === 0 ? [] : [{address: WALLET, share_bps: bps}];
    expect(() => createEconomyPolicy({...feeInput, other_recipients})).toThrow('INCOMPLETE_RECIPIENT_ALLOCATION');
  });

  it.each(['propose_fee_setup', 'propose_fee_claim'] as const)('requires the platform recipient for %s', (action) => {
    expect(() => createEconomyPolicy({...feeInput, allowed_actions: [action], platform_recipient: null}))
      .toThrow('PLATFORM_RECIPIENT_REQUIRED');
  });

  it('accepts an exactly allocated fee policy', () => {
    expect(createEconomyPolicy(feeInput).other_recipients).toEqual([{address: WALLET, share_bps: 8000}]);
  });

  it.each([null, platform])('keeps report-only policies reportable (platform %s)', (platform_recipient) => {
    const policy = createEconomyPolicy({...feeInput, allowed_actions: ['report'], platform_recipient, other_recipients: []});
    const ledger = createEconomyLedger(binding, policy);
    expect(ledger.policy).toEqual(policy);
    expect(economyTreasuryReport(ledger, [])).toMatchObject({economy_id: binding.economy_id, receipt_count: 0});
  });

  it.each<[Partial<EconomyPolicy>, string]>([
    [{other_recipients: []}, 'INCOMPLETE_RECIPIENT_ALLOCATION'],
    [{platform_recipient: null}, 'PLATFORM_RECIPIENT_REQUIRED'],
  ])('reads retained policy %j without permitting an unsigned fee plan', async (overrides, error) => {
    const policy = retained(overrides);
    const ledger = createEconomyLedger(binding, policy);
    expect(ledger.policy).toEqual(policy);
    expect(economyTreasuryReport(ledger, []).receipt_count).toBe(0);
    await expect(buildUnsignedEconomyPlan(binding, policy, chain, {
      plan_id: 'fixture-plan', fee_payer: WALLET, action: 'setup_fee_sharing',
    })).rejects.toThrow(error);
  });

  it('keeps retained structural checks and ownership and approval checks', () => {
    expect(() => createEconomyLedger(binding, retained({owner_id: 'other_owner'}))).toThrow('INACTIVE_ECONOMY_POLICY');
    expect(() => createEconomyLedger(binding, retained({approval_status: 'proposed'}))).toThrow('INACTIVE_ECONOMY_POLICY');
    expect(() => createEconomyLedger(binding, retained({other_recipients: [{address: WALLET, share_bps: 0}]})))
      .toThrow('INVALID_RECIPIENT_SHARE');
  });
});
