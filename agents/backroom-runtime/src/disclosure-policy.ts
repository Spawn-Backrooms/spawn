import * as v from 'valibot';

// On an unknown surface the host must stop discovery and deny the operation.
const inferenceSurfaces = ['inference', 'fallback_inference', 'nested_inference', 'media_generation'] as const;
const surfaces = [...inferenceSurfaces, 'request_capture', 'response_capture', 'flue_transcript',
  'compaction_store', 'artifact', 'tool', 'file', 'cache', 'log', 'browser_state',
  'search', 'fetch', 'diagnostic_export'] as const;
const surface = v.picklist(surfaces);
const inferenceKinds = new Set<string>(inferenceSurfaces);
const mode = v.picklist(['spawn_production', 'external_host']);
const digest = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/));
const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/));
// Reserved placeholders and the automatic router cannot identify a concrete recipient.
const concrete = v.pipe(identifier, v.check(value => !/^(unknown|any|all|default|auto|unresolved|openrouter\/auto)$/i.test(value)));
const integer = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const group = v.picklist(['anthropic', 'openai', 'google', 'xai', 'other']);
const safetySetting = v.picklist(['allow', 'zdr_only']);
const dataClass = v.picklist(['public', 'private_work', 'private_receipt', 'private_identity', 'private_media']);
function setOf<T extends v.GenericSchema<string, string>>(item: T, minimum = 0) {
  return v.pipe(v.array(item), v.minLength(minimum), v.maxLength(64),
    v.check(values => new Set(values).size === values.length), v.transform(values => values.sort()));
}
const scope = { binding_hash: digest, policy_revision: digest, mode };
const edge = v.strictObject({
  id: identifier, surface, call_site: identifier, destination: concrete, endpoint: concrete,
  endpoint_policy_revision: digest, channel: v.picklist(['openrouter', 'external_inference', 'sink']),
  model: v.nullable(concrete), openrouter_group: v.nullable(group),
  implicit_fallbacks: v.literal('disabled'), require_parameters: v.boolean(),
  credential_ref: v.nullable(v.pipe(v.string(), v.regex(/^credential-ref:[0-9a-f]{32}$/))),
  classes: setOf(dataClass, 1), readers: setOf(concrete, 1),
  max_routine_retention_seconds: integer, required_parameters: setOf(identifier),
});
const planSchema = v.strictObject({
  version: v.literal('spawn.disclosure-plan.v1'), ...scope, disabled: setOf(surface),
  edges: v.pipe(v.array(edge), v.minLength(1), v.maxLength(256)),
});
const openRouter = v.strictObject({
  account_revision: digest, guardrail_revision: digest, group, effective_zdr: v.boolean(),
  account_safety_retention: safetySetting,
  guardrail_safety_retention: v.picklist(['allow', 'zdr_only', 'not_applicable']),
  endpoint_tier: v.picklist(['zdr', 'safety', 'retaining']),
});
const qualification = v.strictObject({
  scope: v.strictObject(scope), subject: edge, evidence_hash: digest, eligible: v.boolean(), observed_at_ms: integer,
  expires_at_ms: integer, retention_seconds: integer, supported_parameters: setOf(identifier),
  openrouter: v.nullable(openRouter),
});
const snapshotSchema = v.strictObject({
  plan: planSchema, qualifications: v.pipe(v.array(qualification), v.minLength(1), v.maxLength(256)),
});
const contextSchema = v.strictObject({ ...scope, now_ms: integer, max_age_ms: integer });

export type DisclosurePlan = v.InferOutput<typeof planSchema>;
export type DisclosureSnapshot = v.InferOutput<typeof snapshotSchema>;
export type DisclosureContext = v.InferOutput<typeof contextSchema>;
export type DisclosureDecision = { status: 'match' } | { status: 'deny', reason:
  'invalid_input' | 'scope_mismatch' | 'inventory_mismatch' | 'destination_mismatch' |
  'stale_evidence' | 'unqualified_destination' };

type Edge = v.InferOutput<typeof edge>;
type Qualification = v.InferOutput<typeof qualification>;

// Both objects have been rebuilt in schema order. Set-valued fields are normalized at parse time.
function sameEdge(a: Edge, b: Edge): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function routeQualified(e: Edge, q: Qualification, hostMode: DisclosureContext['mode']): boolean {
  if (!q.eligible || q.retention_seconds > e.max_routine_retention_seconds ||
      !e.required_parameters.every(p => q.supported_parameters.includes(p))) return false;
  if (!inferenceKinds.has(e.surface)) {
    return e.channel === 'sink' && e.model === null && e.openrouter_group === null &&
      q.openrouter === null && !e.require_parameters && e.required_parameters.length === 0;
  }
  if (e.model === null || !e.require_parameters) return false;
  if (e.channel === 'external_inference') {
    return hostMode === 'external_host' && e.openrouter_group === null && q.openrouter === null;
  }
  const policy = q.openrouter;
  if (e.channel !== 'openrouter' || !policy || policy.group !== e.openrouter_group) return false;
  const excludesSafety = policy.account_safety_retention === 'zdr_only' ||
    policy.guardrail_safety_retention === 'zdr_only';
  if (policy.endpoint_tier === 'zdr') {
    return q.retention_seconds === 0 && policy.effective_zdr && excludesSafety;
  }
  if (q.retention_seconds === 0) return false;
  if (policy.endpoint_tier === 'safety') return !excludesSafety;
  return !policy.effective_zdr;
}

/**
 * Compare a host-discovered operation to the separately retrieved, authoritative policy snapshot.
 * Inputs are decoded JSON; the return value carries no authority and performs no dispatch.
 */
export function checkDisclosurePlan(context: unknown, snapshot: unknown, observed: unknown): DisclosureDecision {
  const c = v.safeParse(contextSchema, context);
  const s = v.safeParse(snapshotSchema, snapshot);
  const o = v.safeParse(planSchema, observed);
  if (!c.success || !s.success || !o.success) return { status: 'deny', reason: 'invalid_input' };
  const { plan, qualifications } = s.output;
  for (const candidate of [plan, o.output]) {
    if (candidate.binding_hash !== c.output.binding_hash || candidate.policy_revision !== c.output.policy_revision ||
        candidate.mode !== c.output.mode) return { status: 'deny', reason: 'scope_mismatch' };
  }
  const plannedSurfaces = new Set(plan.edges.map(e => e.surface));
  if (plannedSurfaces.size + plan.disabled.length !== surfaces.length ||
      plan.disabled.some(k => plannedSurfaces.has(k)) || JSON.stringify(plan.disabled) !== JSON.stringify(o.output.disabled))
    return { status: 'deny', reason: 'inventory_mismatch' };

  const actual = new Map(o.output.edges.map(e => [e.id, e]));
  const facts = new Map(qualifications.map(q => [q.subject.id, q]));
  if (new Set(plan.edges.map(e => e.id)).size !== plan.edges.length ||
      actual.size !== o.output.edges.length || facts.size !== qualifications.length ||
      actual.size !== plan.edges.length || facts.size !== plan.edges.length)
    return { status: 'deny', reason: 'inventory_mismatch' };
  for (const e of plan.edges) {
    const a = actual.get(e.id);
    const q = facts.get(e.id);
    if (!a || !q || !sameEdge(e, a) || !sameEdge(e, q.subject))
      return { status: 'deny', reason: 'destination_mismatch' };
    if (q.scope.binding_hash !== plan.binding_hash || q.scope.policy_revision !== plan.policy_revision ||
        q.scope.mode !== plan.mode) return { status: 'deny', reason: 'scope_mismatch' };
    if (c.output.now_ms < q.observed_at_ms || c.output.now_ms >= q.expires_at_ms ||
        c.output.now_ms - q.observed_at_ms > c.output.max_age_ms)
      return { status: 'deny', reason: 'stale_evidence' };
    if (!routeQualified(e, q, c.output.mode)) return { status: 'deny', reason: 'unqualified_destination' };
  }
  return { status: 'match' };
}
