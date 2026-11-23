import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateProjection } from './validate.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(readFileSync(join(directory, 'baseline.json'), 'utf8'));
const copy = () => structuredClone(baseline);
const rejects = (data, pattern) => {
  const result = validateProjection(data);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => pattern.test(error)), result.errors.join('\n'));
};

test('the complete public projection validates while Q01 and release readiness remain incomplete', () => {
  const result = validateProjection(baseline);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.units, 60);
  assert.equal(result.summary.historical_records, 123);
  assert.equal(result.summary.relationships.independent_no_new_delta, 24);
  assert.equal(result.summary.unresolved_historical_records, 123);
  assert.equal(result.summary.q01_completion, 'incomplete');
  assert.equal(result.summary.release_readiness, 'unassessed');
});

test('full Q01 reconciliation fails while owners and canonical acceptance remain unresolved', () => {
  const result = validateProjection(baseline, { requireReconciled: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /Q01 cannot pass/);
});

test('a label change cannot promote the unresolved snapshot to reconciled', () => {
  const data = copy(); data.completion.q01 = 'reconciled';
  rejects(data, /Q01 cannot pass/);
});

test('duplicate historical IDs cannot hide a missing historical obligation', () => {
  const data = copy(); data.historical_records[1].id = data.historical_records[0].id;
  rejects(data, /historical records: duplicate/);
});

test('removing one programme issue rejects an incomplete canonical index', () => {
  const data = copy(); data.units.pop();
  rejects(data, /missing records/);
});

test('two unit IDs cannot share one canonical issue URL', () => {
  const data = copy(); data.units[1].issue_url = data.units[0].issue_url;
  rejects(data, /canonical issue URLs: duplicate/);
});

test('cross-repository substitution rejects the canonical target', () => {
  const data = copy(); const unit = data.units.find((unit) => unit.repository === 'Spawn-Backrooms/spawn');
  unit.issue_url = unit.issue_url.replace('/spawn/issues/', '/backroom-rings/issues/');
  rejects(data, /canonical issue repository mismatch/);
});

test('a qualification gate cannot become a circular implementation prerequisite', () => {
  const data = copy(); data.units.find((unit) => unit.id === 'Q01').depends_on.push('O07');
  rejects(data, /dependency cycle/);
});

test('an independent historical row cannot acquire an unexplained programme mapping', () => {
  const data = copy(); const unit = data.units[0];
  data.historical_records.find((row) => row.relationship === 'independent_no_new_delta').programme_contributions.push({ unit_id: unit.id, issue_url: unit.issue_url });
  rejects(data, /independent relationship disagrees/);
});

test('a declared owner must identify the actual accountable party', () => {
  const data = copy(); data.units[0].accountable_owner.state = 'assigned';
  rejects(data, /owner state and identity disagree/);
});

test('a resolved historical requirement needs an authoritative decision reference', () => {
  const data = copy(); data.historical_records[0].current_requirement.state = 'accepted';
  rejects(data, /requirement decision is missing/);
});

test('missing next actions are rejected instead of silently omitting an unresolved handoff', () => {
  const data = copy(); delete data.historical_records[0].next_action;
  rejects(data, /next_action: missing field/);
});

test('restricted source references cannot enter free-text public fields', () => {
  const data = copy(); data.scope_limits.push(['https:/', 'github.com', 'restricted-example', 'example', 'issues', '1'].join('/'));
  rejects(data, /public boundary/);
});

test('a declared kind cannot become a qualified product by changing one status field', () => {
  const data = copy(); data.room_kinds.qualification = 'qualified';
  rejects(data, /unexpected constant/);
});

test('a reconciled restricted handoff still needs an accountable owner and public verdict', () => {
  const data = copy(); data.handoffs[0].state = 'reconciled';
  rejects(data, /reconciled handoff lacks/);
});

test('a source pin cannot be attached to a different pull request URL', () => {
  const data = copy(); data.repositories[0].prs[0].url = data.repositories[0].prs[1].url;
  rejects(data, /pull request URL mismatch/);
});

test('duplicate first-wave guidance cannot omit an active unit', () => {
  const data = copy(); data.first_wave[1].unit_id = data.first_wave[0].unit_id;
  rejects(data, /first wave: duplicate/);
});

test('every mandatory handoff remains present even when its references are removed', () => {
  for (const omitted of baseline.handoffs.map((handoff) => handoff.id)) {
    const data = copy();
    data.handoffs = data.handoffs.filter((handoff) => handoff.id !== omitted);
    const remaining = data.handoffs[0].id;
    for (const row of data.historical_records) if (row.canonical_work.handoff_id === omitted) row.canonical_work.handoff_id = remaining;
    for (const wave of data.first_wave) wave.handoff_ids = wave.handoff_ids.map((id) => id === omitted ? remaining : id);
    rejects(data, /handoffs: missing records/);
  }
});

test('historical linked acceptance groups cannot disappear or lose a parent', () => {
  const empty = copy(); empty.linked_acceptance_groups = [];
  rejects(empty, /linked_acceptance_groups: unexpected constant/);
  const incomplete = copy(); incomplete.linked_acceptance_groups[0].pop();
  rejects(incomplete, /linked_acceptance_groups: unexpected constant/);
});

test('public source references require an immutable commit path', () => {
  const data = copy();
  data.source_refs[0].url = data.source_refs[0].url.replace(/\/blob\/[a-f0-9]{40}\//, '/blob/main/');
  rejects(data, /source_refs\[0\]\.url: invalid format/);
});

test('private conversation references cannot enter a public decision field', () => {
  const data = copy();
  data.historical_records[0].current_requirement = { state: 'accepted', decision_ref: ['https:/', 'chatgpt.com', 'c', 'synthetic-conversation'].join('/') };
  rejects(data, /public boundary/);
});

function structurallyReconciledFixture() {
  const data = copy();
  const owner = { state: 'assigned', identity: 'synthetic-review-owner' };
  const receipt = data.trackers.core;
  data.completion.q01 = 'reconciled';
  for (const unit of data.units) unit.accountable_owner = { ...owner };
  for (const row of data.historical_records) {
    row.current_requirement = { state: 'accepted', decision_ref: receipt };
    row.accountable_owner = { ...owner };
    row.canonical_work = { state: 'restricted_handoff', public_issue_url: null, handoff_id: 'H-HISTORY' };
    row.residual_acceptance = { state: 'open', evidence_refs: [] };
  }
  for (const handoff of data.handoffs) {
    handoff.state = 'reconciled';
    handoff.accountable_owner = { ...owner };
    handoff.public_receipt = receipt;
  }
  return data;
}

test('structurally reconciled evidence still leaves programme completion and release unassessed', () => {
  const result = validateProjection(structurallyReconciledFixture(), { requireReconciled: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(result.summary.q01_completion, 'reconciled');
  assert.equal(result.summary.programme_completion, 'unassessed');
  assert.equal(result.summary.release_readiness, 'unassessed');
});

test('removing serving evidence cannot bypass the full reconciliation gate', () => {
  const data = structurallyReconciledFixture();
  data.handoffs = data.handoffs.filter((handoff) => handoff.id !== 'H-SERVING');
  const result = validateProjection(data, { requireReconciled: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /handoffs: missing records/);
});
