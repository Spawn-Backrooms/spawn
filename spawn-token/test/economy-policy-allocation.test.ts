import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import * as token from '../src/index.js';
import { WALLET } from './fixtures.js';

const api = token as unknown as Record<string, (...args: any[]) => any>;
const PLATFORM = new PublicKey(new Uint8Array(32).fill(13)).toBase58();
const base = {
  economy_id: 'economy_01',
  owner_id: 'owner_01',
  version: 1,
  fee_basis: 'creator_fees_received',
  basis_confirmed: true,
  approval_status: 'owner_approved',
  platform_recipient: PLATFORM,
  other_recipients: [{ address: WALLET, share_bps: 8000 }],
  allowed_actions: ['propose_fee_setup', 'propose_fee_claim'],
  max_proposal_lamports: '10000',
  max_reserved_lamports: '10000',
};

describe('economy policy recipient allocation', () => {
  it('rejects an incomplete allocation at creation instead of at plan time', () => {
    // Platform takes 2000 bps, so the other recipients must take exactly 8000.
    // A 7500 split leaves 500 bps with no recipient; a 9000 split exceeds 100%.
    expect(() => api.createEconomyPolicy!({ ...base, other_recipients: [{ address: WALLET, share_bps: 7500 }] })).toThrow('INCOMPLETE_RECIPIENT_ALLOCATION');
    expect(() => api.createEconomyPolicy!({ ...base, other_recipients: [{ address: WALLET, share_bps: 9000 }] })).toThrow('INCOMPLETE_RECIPIENT_ALLOCATION');
    expect(() => api.createEconomyPolicy!({ ...base, other_recipients: [] })).toThrow('INCOMPLETE_RECIPIENT_ALLOCATION');
  });

  it('accepts the complete allocation', () => {
    expect(() => api.createEconomyPolicy!(base)).not.toThrow();
  });
});
