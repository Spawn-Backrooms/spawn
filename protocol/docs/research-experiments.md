# Record a research experiment

The E03 contract records a frozen comparison, every planned attempt and the resources it consumed. It does not run an experiment, execute a model, reserve funds, accept learning or authorize publication. Native grants, originals, reservations, review and settlement remain authoritative.

These are new public contracts awaiting canonical maintainer integration. They are not evidence that the hosted product emits these records. Follow the [porting process](../../docs/porting-contributions.md) before a later export or release.

## Freeze the plan before outcomes

1. Fill the [preregistration template](research-preregistration-template.md). Pin each component, task, rights record, intervention, evaluator, decision rule, missing-outcomes rule and analysis method. Record an undisclosed model revision explicitly rather than inventing one.
2. Enumerate the planned assignment units, their lineages, condition allocation, attempt IDs and task IDs. Represent unused attempts later as `not_started`, with a reason. Version 1 uses a fixed roster. New assignments, replacement tasks or additional attempts require a new preregistration and a retained link to the earlier plan.
3. Call `hashResearchAssignmentManifest` with the planned record. Put the result in `preregistration.assignment_manifest_sha256`.
4. Call `hashResearchPreregistration`. Retain that digest with a timestamped, immutable registration through the existing research owner. The function creates a digest, not an authenticated timestamp or approval.
5. For a confirmatory comparison, reference the pilot and freeze the sample-size rule and independent-unit target before confirmatory attempts start. Keep the feasibility pilot and confirmatory observations separate.

```ts
import {
  hashResearchAssignmentManifest,
  hashResearchPreregistration,
  validateResearchExperimentRecord,
  summarizeResearchExperiment,
} from "../spawn-backend/src/core/research-experiment-record";

planned.preregistration.assignment_manifest_sha256 =
  hashResearchAssignmentManifest(planned);
const frozenHash = hashResearchPreregistration(planned.preregistration);
// Retain frozenHash through the existing registration authority.
completed.preregistration_sha256 = frozenHash;
const record = validateResearchExperimentRecord(completed, {
  expectedPreregistrationHash: frozenHash,
});
const summary = summarizeResearchExperiment(record, {
  expectedPreregistrationHash: frozenHash,
});
```

Use the `expectedPreregistrationHash` retained at registration, not a digest freshly supplied by the final record's author. Without it the validator checks internal consistency only; the summary reports `self_consistent_only`. A matched expected digest still does not authenticate the referenced receipts or prove that timestamps, assignment, rights or measurements are truthful.

## Keep the comparisons distinct

Every endpoint names one claim, one control, one treatment, one evaluator and its own decision and uncertainty rules. Transfer, revision, durability, autonomy, sustainability and participation remain separate claims. A transfer advantage against a novice does not establish an improvement over the predecessor revision.

Every plan records a disposition for returning rooms, shared repositories, equally parallel nonsharing rooms, no memory, raw transcripts, ordinary retrieval and the applicable v0 learner. An excluded control needs a reason. The schema does not decide whether that reason makes the experiment persuasive; independent methodology review does.

Record matching for model and tool versions, information, schedule, total compute, review and selection, and human help. The validator checks model/tool reference equality when declared matched. It does not prove semantic matching of budgets, task information or human assistance. Retain their supporting evidence and disclose unmatched dimensions.

When sharing causes interference, assign and analyze independent lineages or cohorts. Repeated tasks within one lineage do not count as additional independent units. A confirmatory decisive finding must meet the registered independent-unit target and include both sides of its comparison. This first version supports fixed targets and pairwise comparisons. A valid early stop below that target is recorded as inconclusive until a separately versioned stopping contract is implemented.

## Retain every attempt

The frozen manifest binds assignment identity, lineage, condition and planned task allocation. The final ledger must contain exactly those attempts. A completed, failed or abandoned attempt has timestamps and evidence. A planned, unstarted or unknown outcome has explicit missing measurements, never a default success or zero score.

Every analysis partitions the full ledger into included and explicitly excluded attempts. Included measurements must be observed and belong to eligible assignments. Confirmatory included tasks must be frozen held-out tasks with unexposed status. A repaired or exposed holdout cannot remain confirmatory evidence under that plan.

Zero eligible cohorts are valid data. Their finding is `not_evaluated`, with no estimate or invented uncertainty interval. A negative result remains negative. A research record cannot activate a capability merely because its analysis is complete.

## Account for the complete cost

Declare `recorded`, `unknown` or `not_applicable` for generation, coordination, review, retrieval, proof, storage, human effort and other resources. Record resources for failed, abandoned and unknown attempts as well as successful ones. Unknown provider dispatch or unresolved accounting remains unknown.

Each entry has a stable `economic_fact_id` and a source reference. Use the authoritative upstream fact identity; do not mint a new identity for a retry, a second receipt for the same cost, or a native mirror of a provider bill. The validator rejects duplicate fact IDs within a record. Cross-record reconciliation still belongs to the native evidence/accounting owner.

Include the full inherited knowledge-production cost once per economic fact, bound to the knowledge artifact. The reported cost includes production and reuse; it does not treat a mature procedure as free. Shared entries use a null `attempt_id`. Human effort is recorded in `human_ms` even when no cash valuation is available.

Monetary values are integer micro-USD strings. The summarizer uses integer arithmetic and reports observed external expense separately from estimated expense, internal transfers and subsidies. Internal transfers and subsidies do not create external demand or reduce resource consumption. Their financial annotations carry no duplicated physical usage and may use any resource category, including `human`. Record actual human effort in a separate human resource entry with `human_ms`.

Coverage describes the underlying resources, so a category marked `recorded` requires a nonfinancial resource entry. A transfer or subsidy alone cannot satisfy that claim. Financial annotations may coexist with `not_applicable` coverage when no underlying resource was used, or `unknown` coverage when it remains unmeasured; unknown coverage still prevents a complete actual-cost total and amortization.

`full_actual_external_micro_usd` is null while data are still collecting or any cost is estimated, unresolved or unmeasured. Known subtotals remain available and are explicitly named subtotals. Gross observed external expense is descriptive accounting, not a second balance, charge, settlement receipt or spending authority.

Amortization returns an exact numerator and denominator per **eligible scheduled attempt**, including failed, abandoned, unknown and unstarted scheduled attempts. It is not a cost per successful task. The numerator includes recorded production and reuse cost. The value is null for zero eligible scheduled attempts, unknown eligibility or incomplete actual cost. Consumers must retain the denominator name, missing outcomes and evidence mode when reporting it.

## Keep evidence and claims honest

`synthetic`, `local_chain`, `native_execution`, `real_provider` and `production_serving` are separate evidence classes. A synthetic record cannot mix in observed classes, and an observed record cannot present synthetic measurements as actual execution. The schema validates labels and references; an independent reviewer must establish the underlying evidence.

A configuration digest records the declared settings. It does not establish actual egress, retention, confidentiality, current provider compatibility or deployment. SPAWN-owned execution keeps its existing authorized OpenRouter policy. External-host comparisons keep their separately qualified disclosure terms. This module changes neither route.

Public records use release-cleared references and synthetic data. Keep credentials, private prompts, user content, native journals and operational settings out of public artifacts. A plain hash is not a privacy guarantee for a guessable input; use the profile's approved opaque or blinded reference where required.

The three [synthetic records](../spawn-backend/tests/fixtures/) demonstrate negative findings, unknown outcomes and zero eligible cohorts. Their costs, measurements, intervals and artifact labels are fabricated examples, not measured scientific results or authenticated source receipts. The validator does not calculate a whitepaper score or statistical interval. Each real experiment must reference its released canonical endpoint definitions and independently verified evaluation implementation.

## Verify the contract

Run from `protocol`:

```sh
npm ci --ignore-scripts
npm run check:types
npm test -- spawn-backend/tests/core/research-experiment-record.test.ts
```

The tests exercise frozen-plan/roster tampering, dropped failures, missing outcomes, interference, contaminated holdouts, underpowered confirmatory claims, exact cost arithmetic and duplicate accounting. These are public contract tests. Native integration, funded cohorts, actual providers and source-to-serving acceptance remain separate qualified outcomes.
