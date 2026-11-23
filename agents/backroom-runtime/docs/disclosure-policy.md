# Checking an operation’s disclosure destinations

A host can compare a resolved operation with a separately qualified disclosure policy before any bytes leave a trust boundary. The public `checkDisclosurePlan(context, snapshot, observed)` function returns `{status: "match"}` or a denial with a fixed reason. See [the contract](../src/disclosure-policy.ts), [a complete synthetic snapshot](../tests/fixtures/disclosure-policy.ts), and [the denial and recovery tests](../tests/disclosure-policy.test.ts).

## Host inputs

1. Derive `context` from the authenticated native original or the separately authorized external host. It pins the current binding hash, policy revision, host mode, trusted current time and maximum evidence age. In the public runtime the native side already resolves the conversation binding, hashes its identity and journals the original model request. Continue to use those authorities for the operation. [Runtime contract](../src/contracts.ts) · [Provider call site](../src/provider.ts)
2. Retrieve `snapshot` through the host’s trusted policy and evidence store. It contains the approved plan and one qualification per edge. The record repeats the complete edge and scope, references the underlying evidence by digest, and gives the observation time, expiry, eligibility, routine retention and supported parameters. Authenticate the source and verify the referenced evidence and revisions in that store. A client-created snapshot or an arbitrary digest supplies no evidence of those facts.
3. Independently derive `observed` from the actual request, account and host configuration. Enumerate **every reachable** model candidate, output capture and downstream reader before sending any data. Expand aliases, model groups, tool/plugin calls and hidden provider defaults. Unknown reachability or an unsupported destination prevents dispatch. Each inference edge describes one fixed endpoint with implicit routing fallback disabled and required-parameter enforcement enabled. A host-managed fallback is a separate prequalified edge. Search services and tools that invoke models must also inventory their nested inference edges. Inspect actual URLs and recipients behind opaque endpoint references in the host’s destination registry.
4. Compare all three decoded JSON inputs before the first disclosure. At each later boundary, including retries and redirects, bind the exact wire operation to the same checked inventory and refresh evidence against the current clock. A change requires another full check. Keep retries associated with the original native operation. Match only establishes agreement among the supplied records. Native grants, budgets, funding, admission and dispatch remain separate prerequisites.

The host owns inventory discovery, evidence authenticity, credential resolution and enforcement at send time. This module performs synchronous comparisons on decoded JSON. It does not enumerate the network or intercept calls. The existing runtime has no call to this module.

## Reader and retention matrix

Each enabled edge states its call site, recipient, endpoint and endpoint-policy revision, model (for generation), data classes, plaintext readers, opaque credential handle (where applicable), and maximum routine retention in seconds. Use multiple edge IDs for independent recipients or fallback candidates of the same kind. Every known surface is enabled with one or more edges or appears in `disabled`. Missing and duplicate dispositions deny the operation. These synthetic fixture rows use one separately named reader and destination per surface.

| Fixture surface | Data classes visible to that reader | Routine retention ceiling |
| --- | --- | --- |
| Main, explicit fallback, nested inference | Private work | 0 seconds |
| Media generation | Private work and media | 0 seconds |
| Request capture, browser state | Private work and identity | 60 seconds |
| Response capture, Flue transcript, compaction store | Private work | 60 seconds |
| Artifact, file | Private work and media | 60 seconds |
| Tool, search, fetch, cache | Private work | 60 seconds |
| Log, diagnostic export | Private receipt | 60 seconds |

The fixture values are invented. An opaque `credential-ref:<32 lowercase hex>` identifies an existing host-managed credential. Keep actual secrets out of every field and diagnostic. Names and hashes also reveal metadata, so share a policy only under its applicable disclosure terms.

## Endpoint evidence

SPAWN-owned production inference uses only a concrete OpenRouter route. A separately bound external host may qualify a different inference route under its own terms. For OpenRouter, the snapshot pins the account and guardrail revisions, resolved model group, effective enforcement and Safety Retention dispositions, along with the endpoint’s observed tier. When no guardrail applies, retain evidence of that binding decision and record `not_applicable` for the guardrail disposition. The selected group must agree with the qualified edge.

The strict zero-routine-retention profile requires an eligible ZDR endpoint, effective ZDR enforcement and an effective account or guardrail disposition excluding Safety Retention. A positive operation ceiling still requires a compatible endpoint tier. This contract rejects positive routine retention on a ZDR-tier endpoint, a retaining endpoint under effective ZDR enforcement, and a Safety Retention endpoint when either disposition selects ZDR only. A request boolean alone cannot establish those settings. Provider processing still exposes plaintext to authorized readers. OpenRouter documents legally required preservation and in-flight screening exceptions. Evaluate the full terms independently if an operation requires stronger assurance. [OpenRouter ZDR documentation](https://openrouter.ai/docs/guides/features/zdr)

Each inference edge pins its required parameters and checks the endpoint’s supported set. Capture, logs, tools and caches need their own qualified edges and evidence. [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) · [Scope of inference retention](https://openrouter.ai/blog/insights/zero-data-retention/)

## Verification

Run `node --test tests/disclosure-policy.test.ts`, `npm test` and `npm run check:types` from this package. The suite uses harmless local markers with a fabricated clock, original, recipients and policy. It checks that late discovery of an unapproved recipient prevents all marker deliveries and that the restored authorized operation matches. Fresh native canaries and independently qualified provider, cache and storage evidence are required to establish actual enforcement.
