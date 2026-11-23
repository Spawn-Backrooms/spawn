import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDisclosurePlan } from '../src/disclosure-policy.ts';
import { digest, disclosureFixture } from './fixtures/disclosure-policy.ts';

type Fixture = ReturnType<typeof disclosureFixture>;
const check = (f: Fixture) => checkDisclosurePlan(f.context, f.snapshot, f.observed);
const deny = (f: Fixture) => assert.equal(check(f).status, 'deny');

test('every fabricated marker stays local until the entire inventory matches', () => {
  const f = disclosureFixture();
  const sent: string[] = [];
  function dispatch() {
    if (check(f).status !== 'match') return;
    for (const e of f.observed.edges) sent.push('canary:' + e.surface);
  }
  f.observed.edges.at(-1)!.endpoint = 'unlisted-diagnostics';
  dispatch();
  assert.deepEqual(sent, []);
  f.observed = structuredClone(f.snapshot.plan);
  dispatch();
  assert.deepEqual(sent, f.snapshot.plan.edges.map(e => 'canary:' + e.surface));
});
const changes: [string, (f: Fixture) => void][] = [
  ['discovery omits a sink', f => { f.observed.edges.pop(); }],
  ['disabled surface enabled', f => {
    f.snapshot.plan.edges.pop(); f.snapshot.plan.disabled.push('diagnostic_export'); f.snapshot.qualifications.pop();
  }],
  ['unclassified surface omitted on both sides', f => {
    f.snapshot.plan.edges.pop(); f.snapshot.qualifications.pop(); f.observed.edges.pop();
  }],
  ['qualification for a different endpoint', f => { f.snapshot.qualifications[0].subject.endpoint = 'other'; }],
  ['qualification copied from a different binding', f => { f.snapshot.qualifications[0].scope.binding_hash = digest('9'); }],
  ['unknown destination declared on every input', f => {
    f.snapshot.plan.edges[0].destination = 'unknown'; f.snapshot.qualifications[0].subject.destination = 'unknown';
    f.observed = structuredClone(f.snapshot.plan);
  }],
  ['unresolved model routing selector', f => {
    f.snapshot.plan.edges[0].model = 'openrouter/auto'; f.snapshot.qualifications[0].subject.model = 'openrouter/auto';
    f.observed = structuredClone(f.snapshot.plan);
  }],
  ['wrong OpenRouter group', f => { f.snapshot.qualifications[0].openrouter!.group = 'google'; }],
  ['extra fallback edge', f => { f.observed.edges.push({ ...f.observed.edges[1], id: 'extra' }); }],
  ['nested reader expands', f => { f.observed.edges[2].readers.push('extra-reader'); }],
  ['changed media model', f => { f.observed.edges[3].model = 'other/model'; }],
  ['changed endpoint revision', f => { f.observed.edges[0].endpoint_policy_revision = digest('0'); }],
  ['extra data class', f => { f.observed.edges[0].classes.push('private_receipt'); }],
  ['extra tool field', f => { Object.assign(f.observed.edges[9], { forwarding: true }); }],
  ['different call site', f => { f.observed.edges[2].call_site = 'root/elsewhere'; }],
  ['unknown cache disposition', f => { f.snapshot.qualifications[11].eligible = false; }],
  ['unqualified tool', f => { f.snapshot.qualifications.splice(9, 1); }],
  ['unsupported required parameter', f => { f.snapshot.qualifications[0].supported_parameters = []; }],
  ['observed log retention exceeds policy', f => { f.snapshot.qualifications[12].retention_seconds++; }],
  ['old snapshot', f => { f.context.max_age_ms = 49; }],
  ['expired snapshot', f => { f.context.now_ms = 200; }],
  ['observation from future', f => { f.context.now_ms = 99; }],
  ['stale policy revision', f => { f.context.policy_revision = digest('1'); }],
  ['wrong original binding', f => { f.context.binding_hash = digest('3'); }],
  ['request boolean alone', f => { Object.assign(f.snapshot.qualifications[0], { openrouter: { zdr: true } }); }],
  ['effective policy permits Safety Retention', f => { f.snapshot.qualifications[0].openrouter!.guardrail_safety_retention = 'allow'; }],
  ['effective account/guardrail policy absent', f => { f.snapshot.qualifications[0].openrouter = null; }],
  ['Safety Retention endpoint', f => { f.snapshot.qualifications[0].openrouter!.endpoint_tier = 'safety'; }],
  ['unknown guardrail', f => { f.snapshot.qualifications[0].openrouter!.guardrail_safety_retention = 'unknown'; }],
  ['known non-enforcement', f => { f.snapshot.qualifications[0].openrouter!.effective_zdr = false; }],
  ['reclassifying a nested generation as a storage sink', f => {
    Object.assign(f.snapshot.plan.edges[2], { channel: 'sink', model: null });
    f.snapshot.qualifications[2].subject = structuredClone(f.snapshot.plan.edges[2]);
    f.snapshot.qualifications[2].openrouter = null; f.observed = structuredClone(f.snapshot.plan);
  }],
  ['production inference moved to an external host', f => {
    Object.assign(f.snapshot.plan.edges[0], { channel: 'external_inference', openrouter_group: null });
    f.snapshot.qualifications[0].subject = structuredClone(f.snapshot.plan.edges[0]); f.snapshot.qualifications[0].openrouter = null;
    f.observed = structuredClone(f.snapshot.plan);
  }],
  ['self-asserted external mode', f => {
    f.snapshot.plan.mode = 'external_host'; f.observed.mode = 'external_host';
  }],
  ['duplicate edge and reused evidence slot', f => {
    f.snapshot.plan.edges[1].id = f.snapshot.plan.edges[0].id; f.observed = structuredClone(f.snapshot.plan);
  }],
];
for (const [name, change] of changes) test('deny ' + name, () => {
  const f = disclosureFixture(); change(f); deny(f);
});

test('independently authorized external host can qualify its own inference endpoints', () => {
  const f = disclosureFixture();
  f.context.mode = f.snapshot.plan.mode = 'external_host';
  for (const q of f.snapshot.qualifications) q.scope.mode = 'external_host';
  for (const [i, edge] of f.snapshot.plan.edges.entries()) {
    if (edge.channel !== 'openrouter') continue;
    edge.channel = 'external_inference'; edge.openrouter_group = null;
    f.snapshot.qualifications[i].subject = structuredClone(edge); f.snapshot.qualifications[i].openrouter = null;
  }
  f.observed = structuredClone(f.snapshot.plan);
  assert.equal(check(f).status, 'match');
});
test('an explicitly disabled surface is distinct from an unknown one', () => {
  const f = disclosureFixture();
  f.snapshot.plan.disabled.push(f.snapshot.plan.edges.pop()!.surface);
  f.snapshot.qualifications.pop(); f.observed = structuredClone(f.snapshot.plan);
  assert.equal(check(f).status, 'match');
});

test('reader and class order are sets and edge order is irrelevant', () => {
  const f = disclosureFixture(), e = f.snapshot.plan.edges[0];
  e.readers.push('fixture-auditor'); e.classes.push('private_identity');
  f.snapshot.qualifications[0].subject = structuredClone(e);
  f.observed = structuredClone(f.snapshot.plan);
  f.observed.edges[0].readers.reverse(); f.observed.edges[0].classes.reverse(); f.observed.edges.reverse();
  assert.deepEqual(check(f), { status: 'match' });
});
test('denial diagnostics exclude credential values and every marker', () => {
  const f = disclosureFixture();
  Object.assign(f.observed.edges[0], { secret: 'canary-secret' });
  assert.deepEqual(check(f), { status: 'deny', reason: 'invalid_input' });
});
test('an explicit second fallback destination needs its own policy and current evidence', () => {
  const f = disclosureFixture(), candidate = structuredClone(f.snapshot.plan.edges[1]);
  candidate.id = 'fallback-two'; candidate.endpoint = 'second-endpoint';
  f.snapshot.plan.edges.push(candidate); f.observed = structuredClone(f.snapshot.plan);
  deny(f);
  f.snapshot.qualifications.push({ ...structuredClone(f.snapshot.qualifications[1]), subject: structuredClone(candidate) });
  assert.deepEqual(check(f), { status: 'match' });
});

// Set the same edge on all three inputs so these cases isolate qualification or schema rules.
function alignMainEdge(f: Fixture) {
  f.snapshot.qualifications[0].subject = structuredClone(f.snapshot.plan.edges[0]);
  f.observed.edges[0] = structuredClone(f.snapshot.plan.edges[0]);
}

test('deny a malformed credential even when all three records agree', () => {
  const f = disclosureFixture();
  f.snapshot.plan.edges[0].credential_ref = 'synthetic-literal-value';
  alignMainEdge(f);
  assert.deepEqual(check(f), { status: 'deny', reason: 'invalid_input' });
});
test('deny implicit provider fallback even when all three records agree', () => {
  const f = disclosureFixture();
  f.snapshot.plan.edges[0].implicit_fallbacks = 'enabled';
  alignMainEdge(f);
  assert.deepEqual(check(f), { status: 'deny', reason: 'invalid_input' });
});
test('deny unenforced required parameters even when all three records agree', () => {
  const f = disclosureFixture();
  f.snapshot.plan.edges[0].require_parameters = false;
  alignMainEdge(f);
  assert.deepEqual(check(f), { status: 'deny', reason: 'unqualified_destination' });
});

const tierCases = [
  // Endpoint tier, routine seconds, enforced ZDR, account setting, guardrail setting, expected result.
  ['retaining', 600, true,  'allow',    'allow',          'deny'],
  ['safety',    600, true,  'allow',    'zdr_only',       'deny'],
  ['safety',    600, true,  'zdr_only', 'allow',          'deny'],
  ['safety',    600, false, 'zdr_only', 'not_applicable', 'deny'],
  ['safety',    600, false, 'allow',    'zdr_only',       'deny'],
  ['zdr',       600, true,  'allow',    'zdr_only',       'deny'],
  ['zdr',       600, false, 'allow',    'allow',          'deny'],
  ['safety',    600, true,  'allow',    'allow',          'match'],
  ['retaining', 600, false, 'allow',    'allow',          'match'],
  ['zdr',         0, true,  'zdr_only', 'not_applicable', 'match'],
  ['zdr',         0, true,  'allow',    'zdr_only',       'match'],
] as const;
for (const [tier, seconds, effective, account, guardrail, expected] of tierCases) {
  test(`${expected} ${tier} tier at ${seconds}s with effective ZDR ${effective}, account ${account}, guardrail ${guardrail}`, () => {
    const f = disclosureFixture(), q = f.snapshot.qualifications[0];
    f.snapshot.plan.edges[0].max_routine_retention_seconds = seconds === 0 ? 0 : 86400;
    alignMainEdge(f);
    q.retention_seconds = seconds;
    Object.assign(q.openrouter!, { endpoint_tier: tier, effective_zdr: effective,
      account_safety_retention: account, guardrail_safety_retention: guardrail });
    assert.deepEqual(check(f), expected === 'match' ? { status: 'match' }
      : { status: 'deny', reason: 'unqualified_destination' });
  });
}
