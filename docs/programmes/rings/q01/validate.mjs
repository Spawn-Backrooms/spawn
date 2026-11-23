import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(directory, 'schema.json'), 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function shape(value, rule, path, errors) {
  if (rule.$ref) return shape(value, schema.$defs[rule.$ref.split('/').at(-1)], path, errors);
  if ('const' in rule && !same(value, rule.const)) errors.push(`${path}: unexpected constant`);
  if (rule.enum && !rule.enum.some((candidate) => same(candidate, value))) errors.push(`${path}: unsupported value`);
  const types = rule.type ? [].concat(rule.type) : [];
  const isType = (type) => type === 'object' ? record(value) : type === 'array' ? Array.isArray(value) : type === 'null' ? value === null : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type;
  if (types.length && !types.some(isType)) { errors.push(`${path}: wrong type`); return; }
  if (typeof value === 'string') {
    if (rule.minLength && value.length < rule.minLength) errors.push(`${path}: empty value`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${path}: invalid format`);
  }
  if (typeof value === 'number' && rule.minimum !== undefined && value < rule.minimum) errors.push(`${path}: below minimum`);
  if (Array.isArray(value)) {
    if (rule.minItems && value.length < rule.minItems) errors.push(`${path}: missing records`);
    if (rule.items) value.forEach((item, i) => shape(item, rule.items, `${path}[${i}]`, errors));
  }
  if (record(value) && rule.properties) {
    for (const key of rule.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: missing field`);
    for (const [key, item] of Object.entries(value)) {
      if (rule.properties[key]) shape(item, rule.properties[key], `${path}.${key}`, errors);
      else if (rule.additionalProperties === false) errors.push(`${path}.${key}: unsupported field`);
    }
  }
}

export function validateProjection(data, { requireReconciled = false } = {}) {
  const errors = [];
  shape(data, schema, '$', errors);
  if (errors.length) return { valid: false, errors, summary: null };
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const unique = (values, name) => check(new Set(values).size === values.length, `${name}: duplicate value`);
  const units = new Map(data.units.map((unit) => [unit.id, unit]));
  const handoffs = new Map(data.handoffs.map((handoff) => [handoff.id, handoff]));
  const requiredIds = schema.$defs.unitId.enum;
  const historicalIds = schema.$defs.historicalId.enum;
  unique(data.units.map((unit) => unit.id), 'units');
  unique(data.units.map((unit) => unit.issue_url), 'canonical issue URLs');
  check(data.units.length === requiredIds.length && requiredIds.every((id) => units.has(id)), 'units: incomplete canonical index');
  unique(data.historical_records.map((row) => row.id), 'historical records');
  check(data.historical_records.length === historicalIds.length, 'historical records: incomplete denominator');
  unique(data.handoffs.map((handoff) => handoff.id), 'handoffs');
  check(data.handoffs.length === schema.$defs.handoffId.enum.length && schema.$defs.handoffId.enum.every((id) => handoffs.has(id)), 'handoffs: incomplete mandatory set');
  unique(data.repositories.map((repository) => repository.repository), 'repositories');
  check(data.repositories.length === 2, 'repositories: incomplete or unexpected set');
  for (const repository of data.repositories) {
    unique(repository.prs.map((pr) => pr.number), `${repository.repository} pull requests`);
    for (const pr of repository.prs) {
      check(pr.url === `https://github.com/${repository.repository}/pull/${pr.number}`, `${repository.repository}#${pr.number}: pull request URL mismatch`);
      unique(pr.files, `${repository.repository}#${pr.number} changed files`);
    }
  }
  unique(data.source_refs.map((source) => source.id), 'source references');
  check(data.source_refs.some((source) => source.id === data.room_kinds.source_ref), 'room kinds: unknown source reference');
  unique(data.room_kinds.declared, 'room kinds');
  check(data.room_kinds.declared.length === 6, 'room kinds: declared kind set differs');
  check(Date.parse(data.observed_window.started_at) <= Date.parse(data.observed_window.ended_at), 'observation window: invalid ordering');
  const ownerValid = (owner, name) => check(owner.state === 'assigned' ? typeof owner.identity === 'string' && owner.identity.trim().length > 0 : owner.identity === null, `${name}: owner state and identity disagree`);
  for (const unit of data.units) {
    check(new RegExp(`^https://github\\.com/${unit.repository}/issues/[1-9]\\d*$`).test(unit.issue_url), `${unit.id}: canonical issue repository mismatch`);
    unique(unit.depends_on, `${unit.id} dependencies`);
    ownerValid(unit.accountable_owner, unit.id);
    for (const dep of unit.depends_on) check(units.has(dep), `${unit.id}: unknown dependency ${dep}`);
  }
  const visited = new Set(), active = new Set();
  function visit(id) {
    if (active.has(id)) { errors.push(`dependency cycle at ${id}`); return; }
    if (visited.has(id) || !units.has(id)) return;
    active.add(id);
    for (const dep of units.get(id).depends_on) visit(dep);
    active.delete(id); visited.add(id);
  }
  for (const id of units.keys()) visit(id);
  const relationshipCounts = {};
  for (const row of data.historical_records) {
    ownerValid(row.accountable_owner, row.id);
    relationshipCounts[row.relationship] = (relationshipCounts[row.relationship] ?? 0) + 1;
    unique(row.programme_contributions.map((item) => item.unit_id), `${row.id} contributions`);
    check((row.relationship === 'independent_no_new_delta') === (row.programme_contributions.length === 0), `${row.id}: independent relationship disagrees with contribution mapping`);
    for (const contribution of row.programme_contributions) check(units.get(contribution.unit_id)?.issue_url === contribution.issue_url, `${row.id}: noncanonical contribution link`);
    check(handoffs.has(row.canonical_work.handoff_id), `${row.id}: unknown canonical handoff`);
    check(row.current_requirement.state === 'unresolved' ? row.current_requirement.decision_ref === null : typeof row.current_requirement.decision_ref === 'string' && row.current_requirement.decision_ref.trim().length > 0, `${row.id}: requirement decision is missing or inconsistent`);
    check(row.canonical_work.state === 'public_issue' ? /^https:\/\/github\.com\/Spawn-Backrooms\/[^/]+\/issues\/[1-9]\d*$/.test(row.canonical_work.public_issue_url ?? '') : row.canonical_work.public_issue_url === null, `${row.id}: canonical work state and URL disagree`);
    if (['fulfilled', 'not_applicable'].includes(row.residual_acceptance.state)) check(row.residual_acceptance.evidence_refs.length > 0, `${row.id}: residual acceptance has no evidence`);
  }
  for (const group of data.linked_acceptance_groups) unique(group, 'linked acceptance group');
  for (const handoff of data.handoffs) {
    ownerValid(handoff.accountable_owner, handoff.id);
    if (handoff.state === 'reconciled') check(handoff.accountable_owner.state === 'assigned' && handoff.public_receipt !== null, `${handoff.id}: reconciled handoff lacks owner or public verdict`);
  }
  const firstWaveIds = ['Q02', 'Q03', 'Q05', 'K01', 'E03'];
  unique(data.first_wave.map((wave) => wave.unit_id), 'first wave');
  check(data.first_wave.length === firstWaveIds.length && firstWaveIds.every((id) => data.first_wave.some((wave) => wave.unit_id === id)), 'first wave: incomplete or unexpected set');
  for (const wave of data.first_wave) for (const id of wave.handoff_ids) check(handoffs.has(id), `${wave.unit_id}: unknown preparation handoff`);
  check(!/github\.com\/(?!Spawn-Backrooms\/(?:spawn|backroom-rings)(?:\/|["\s]))|chatgpt\.com\/|libfile_|\/workspace\//i.test(JSON.stringify(data)), 'public boundary: restricted reference');
  const unresolvedHistorical = data.historical_records.filter((row) => row.current_requirement.state === 'unresolved' || row.accountable_owner.state !== 'assigned' || row.canonical_work.state === 'unresolved' || row.residual_acceptance.state === 'unreconciled').length;
  const unresolvedHandoffs = data.handoffs.filter((handoff) => handoff.state !== 'reconciled').length;
  const unassignedUnits = data.units.filter((unit) => unit.accountable_owner.state !== 'assigned').length;
  const reconciled = unresolvedHistorical === 0 && unresolvedHandoffs === 0 && unassignedUnits === 0;
  if (data.completion.q01 === 'reconciled' || requireReconciled) check(reconciled, 'Q01 cannot pass with unresolved requirement, owner, residual-acceptance or handoff records');
  const summary = { units: units.size, historical_records: data.historical_records.length, relationships: relationshipCounts, unresolved_historical_records: unresolvedHistorical, unresolved_handoffs: unresolvedHandoffs, unassigned_units: unassignedUnits, q01_completion: reconciled ? 'reconciled' : 'incomplete', programme_completion: 'unassessed', release_readiness: 'unassessed' };
  return { valid: errors.length === 0, errors, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const requireReconciled = args.includes('--require-reconciled');
  const files = args.filter((arg) => arg !== '--require-reconciled');
  if (files.length > 1 || files.some((arg) => arg.startsWith('--'))) {
    process.stderr.write('Usage: node validate.mjs [baseline.json] [--require-reconciled]\n'); process.exitCode = 2;
  } else {
    try {
      const data = JSON.parse(readFileSync(files[0] ?? join(directory, 'baseline.json'), 'utf8'));
      const result = validateProjection(data, { requireReconciled });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.valid ? 0 : 1;
    } catch (error) { process.stderr.write(`Invalid projection: ${error.message}\n`); process.exitCode = 1; }
  }
}
