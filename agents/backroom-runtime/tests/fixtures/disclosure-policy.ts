// Fabricated endpoint, policy and credential references. No network fixture.
const surfaces = [
  'inference', 'fallback_inference', 'nested_inference', 'media_generation',
  'request_capture', 'response_capture', 'flue_transcript', 'compaction_store',
  'artifact', 'tool', 'file', 'cache', 'log', 'browser_state', 'search', 'fetch', 'diagnostic_export',
] as const;
export const digest = (digit: string) => 'sha256:' + digit.repeat(64);
export function disclosureFixture() {
  const edges = surfaces.map((surface, index) => {
    const generation = index < 4;
    const classes: string[] = ['private_work'];
    if (surface === 'media_generation' || surface === 'artifact' || surface === 'file') classes.push('private_media');
    if (surface === 'request_capture' || surface === 'browser_state') classes.push('private_identity');
    if (surface === 'log' || surface === 'diagnostic_export') classes.splice(0, 1, 'private_receipt');
    return {
      id: 'edge-' + surface, surface, call_site: 'root/' + surface,
      destination: 'fixture-' + surface, endpoint: 'fixture-endpoint-' + surface,
      endpoint_policy_revision: digest('c'), channel: generation ? 'openrouter' : 'sink',
      model: generation ? 'fixture/provider-model' : null,
      openrouter_group: generation ? 'other' : null,
      implicit_fallbacks: 'disabled', require_parameters: generation,
      credential_ref: generation ? 'credential-ref:' + '8'.repeat(32) : null,
      classes, readers: ['fixture-reader-' + surface],
      max_routine_retention_seconds: generation ? 0 : 60,
      required_parameters: generation ? ['response_format'] : [],
    };
  });
  const plan = { version: 'spawn.disclosure-plan.v1', binding_hash: digest('a'),
    policy_revision: digest('b'), mode: 'spawn_production', disabled: [] as string[], edges };
  const qualifications = edges.map(edge => ({
    scope: { binding_hash: plan.binding_hash, policy_revision: plan.policy_revision, mode: plan.mode },
    subject: structuredClone(edge), evidence_hash: digest('d'), eligible: true,
    observed_at_ms: 100, expires_at_ms: 200,
    retention_seconds: edge.max_routine_retention_seconds,
    supported_parameters: [...edge.required_parameters],
    openrouter: edge.channel === 'openrouter' ? {
      account_revision: digest('e'), guardrail_revision: digest('f'), group: 'other',
      effective_zdr: true, account_safety_retention: 'allow', guardrail_safety_retention: 'zdr_only',
      endpoint_tier: 'zdr',
    } : null,
  }));
  const context = { binding_hash: plan.binding_hash, policy_revision: plan.policy_revision,
    mode: plan.mode, now_ms: 150, max_age_ms: 100 };
  return { context, snapshot: { plan, qualifications }, observed: structuredClone(plan) };
}
