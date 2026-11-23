# Q01 public source and traceability projection

This is the reviewable public slice of [Q01](https://github.com/Spawn-Backrooms/spawn/issues/35). It records a dated source and overlap baseline, indexes all 60 programme issues, and projects the relationships of 123 historical planning records. **Q01 remains incomplete.** Current requirement acceptance, accountable owners, canonical work, residual acceptance, capability applicability and serving evidence still require reconciliation.

The accepted native requirement and release registers retain authority. This directory is a public audit projection and does not select a release, replace the programme's issue graph, or establish a new completion denominator. [O07](https://github.com/Spawn-Backrooms/spawn/issues/72) owns the accepted completion register and completion accounting.

## Files

| File | Purpose |
| --- | --- |
| `baseline.json` | Public repository/PR pins and changed files, source references, collision guidance, 60-unit index, 123-record crosswalk, explicit unresolved handoffs. |
| `schema.json` | Versioned JSON Schema with the exact programme, historical and mandatory handoff ID sets, plus the retained historical acceptance groups. Objects reject unrecognized fields. |
| `validate.mjs` | Dependency-free shape and semantic checks, including the separate reconciliation gate. |
| `validate.test.mjs` | Focused positive and negative fixtures for integrity, public boundaries and unresolved completion. |

## Observed public sources

The branch and PR observations cover **2026-11-23 12:37:29–12:43:27 UTC**. They are a dated snapshot; refresh the affected head and file ownership immediately before overlapping writes. Source presence and a PR's recorded test results are distinct from tests independently run for this projection.

| Source | Observed commit | Role |
| --- | --- | --- |
| [Core main](https://github.com/Spawn-Backrooms/spawn/tree/e26e2585d01518ec4d86b93863f6e0fbde724338) | `e26e2585d01518ec4d86b93863f6e0fbde724338` | Public exported source and contributor conventions. |
| [Rings main](https://github.com/Spawn-Backrooms/backroom-rings/tree/f1422580abcdd60baaa6c528fff1fe8ddca511c0) | `f1422580abcdd60baaa6c528fff1fe8ddca511c0` | Public engine baseline. |
| [Rings PR #3](https://github.com/Spawn-Backrooms/backroom-rings/pull/3) | `b61f57b1c553d2f39399cc2d1db5d0ade43c67f9` | Open production-artifact and gateway-recovery candidate on Rings main. |
| [Rings PR #4](https://github.com/Spawn-Backrooms/backroom-rings/pull/4) | `19edcee0ad75b28fda81b7e80f49255f9804ce8d` | Draft indexer-exit supervision candidate based on PR #3's observed head. |

The manifest includes all **10 open core PRs and two open Rings PRs** observed in that window, with exact head/base commits and changed-file lists. An author or GitHub assignee is source metadata; it does not establish accepted implementation, integration or acceptance ownership. All 60 programme accountable-owner records remain explicitly unassigned in this projection.

The pinned [contribution guide](https://github.com/Spawn-Backrooms/spawn/blob/e26e2585d01518ec4d86b93863f6e0fbde724338/CONTRIBUTING.md) and [porting contract](https://github.com/Spawn-Backrooms/spawn/blob/e26e2585d01518ec4d86b93863f6e0fbde724338/docs/porting-contributions.md) apply. A canonical maintainer must preserve accepted public work in the native source before a future export. The canonical mapping and export treatment of this new directory remain pending in `H-PORT`.

No equivalent general completion register was identified in the inspected public main tree. The existing native requirement/release authority must be reconciled through an authorized-maintainer handoff. An absent public file is not evidence that no canonical register exists.

## Historical traceability and residual work

The crosswalk preserves the historical IDs, relation classes and programme contributions. It omits historical private descriptions and source references. No draft record has been promoted to an accepted requirement.

| Historical relation | Records | Interpretation |
| --- | ---: | --- |
| `direct_delta` | 23 | The programme contributes a directly related change; the parent acceptance still needs reconciliation. |
| `preserved_dependency` | 53 | Existing work must be preserved; the mapping does not create another issue-graph dependency. |
| `scoped_release_evidence` | 20 | The programme contributes evidence for a bounded release scope. |
| `bounded_research` | 3 | The programme contributes a defined research question or result. |
| `independent_no_new_delta` | 24 | The historical work remains outside the mapped programme contribution. |
| **Total historical records** | **123** | **Current acceptance and residual obligations remain unresolved.** |

The 99 related records may retain substantial acceptance outside their programme contribution. The other 24 remain visible with an empty contribution list and an explicit next handoff. Neither group is marked complete. Linked acceptance groups preserve duplicate-parent relationships without merging or counting them as delivered.

Each row records its unresolved current requirement, unassigned owner, unresolved canonical work, unreconciled residual acceptance, unassessed closure and next action. `H-HISTORY` must reconcile the authoritative register, existing issues, legacy work-package lineage, accepted replacements, evidence revision and capability applicability before those values can change. Look for existing work before opening additional tickets.

The public room schema declares `coding`, `art`, `video`, `research`, `live_avatar` and `trading`. This is a declared-kind inventory. It establishes no qualification of domain operations, media execution, repository operations, host modes, runtime routes or privacy profiles. Those applicable capability profiles and their evidence remain part of the Q01/O07 handoff.

## First-wave file boundaries

These are preparation permissions for bounded work, subject to refreshing the affected source. They are not delivery or release verdicts.

| Unit | Work that can proceed | Shared boundary requiring coordination |
| --- | --- | --- |
| Q02 | Public contract review and isolated compatibility fixtures. | Canonical runtime, session, startup recovery, generated MCP and source/export integration. |
| Q03 | Reproduce a deliberately selected public package revision and record provenance. | Existing Rings PR #3/#4 stack; select the intended base rather than silently mixing revisions. |
| Q05 | Disclosure and reader/egress contracts using non-sensitive fixtures. | Actual native/provider enforcement and persistence. |
| K01 | Isolated envelope/schema/fixture files. | Rings client index, gateway protocol, package exports and release manifests overlap current work. |
| E03 | Isolated experiment/resource record, validator and fixtures. | Existing room/coordinator/workflow schemas, generated MCP and canonical export overlays. |

The five unresolved handoffs cover native integration (`H-NATIVE`), contribution preservation and export mapping (`H-PORT`), historical requirements (`H-HISTORY`), current serving evidence (`H-SERVING`), and concurrent or unpushed work (`H-ACTIVE-WORK`). Restricted evidence stays with the authorized maintainer; this projection records only a public-safe identifier and, when available, a release-cleared verdict.

## Validate

Use Node.js 24 or later from the repository root:

```sh
node docs/programmes/rings/q01/validate.mjs
node --test docs/programmes/rings/q01/validate.test.mjs
node docs/programmes/rings/q01/validate.mjs --require-reconciled
```

The first command validates projection integrity. For this snapshot it returns success with 60 units, 123 historical records, 123 unresolved historical records, five unresolved handoffs and 60 unassigned programme owners. The focused suite has 23 tests.

**The third command must exit with status 1 for this snapshot.** It rejects full Q01 reconciliation while requirements, owners, residual acceptance or handoffs remain unresolved. Setting `completion.q01` to `reconciled` cannot bypass that check. Programme completion and release readiness remain `unassessed` even if a future snapshot reconciles Q01's records.

`schema.json` is a standard JSON Schema document. The dependency-free runner implements the schema keywords used here and additional semantic checks; it is not a general JSON Schema engine. It checks identity sets, immutable source-reference paths, links, dependencies, owner-state consistency, required decision references, explicit unknowns and public-reference restrictions. All five mandatory handoffs and the ordered historical acceptance groups are retained in this version; removing them cannot bypass reconciliation. It cannot establish the truth of a maintainer's decision, consent to ownership, a deployed identity or an acceptance result. Those require reviewable source evidence and the existing authority.

## Refresh and review

1. Refresh the affected public repository main and PR heads, bases, metadata and changed-file lists. Record the observation window. Keep recorded PR verification separate from verification actually rerun.
2. Read the canonical issue markers and dependencies from the 60 public issues. Preserve one issue per unit. Treat source-overlap references and historical contributions separately from dependency edges.
3. Project historical records by an explicit field allowlist: historical ID, relationship and programme unit IDs. Resolve issue URLs through the public unit index. Preserve the 123-ID set and linked acceptance groups; do not copy arbitrary source properties or private narrative.
4. Change unresolved requirement, owner, canonical-work or residual values only from an accepted, public-safe decision or an authorized-maintainer verdict. Keep restricted source revisions, internal references, operator configuration and user data outside this directory.
5. Validate the projection and focused negative cases. Request independent review of source accuracy, canonical authority, missing residual acceptance and public boundaries. Refresh shared-file ownership before implementation.

This public slice does not run application tests, model/provider calls, deployment probes, production activation or release qualification. It makes the available source and remaining reconciliation work concrete and reviewable without treating those unknowns as completion.
