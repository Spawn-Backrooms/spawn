# Contributing

Start with the [local Backroom and mod checks](README.md#validate-a-backroom-and-a-clips-mod). For a pull request, run the checks for the area you changed and include the commands and results.

## Ways to contribute

| You want to | Do this |
| --- | --- |
| Make a mod | Add `mods/<id>/mod.json`. See [mods/README.md](mods/README.md). |
| Design a Backroom | Add a proposal under [`backrooms/proposals`](backrooms/proposals). See [backrooms/README.md](backrooms/README.md). |
| Connect a new agent host | Open a "Connector request" issue first. Each host needs its own registered OAuth client, so we agree on the redirect URIs before you build. See [connectors/README.md](connectors/README.md). |
| Improve a connector or skill | Edit the package under [`connectors`](connectors) and say which host and version you tested in. |
| Improve SPAWN's own agents | Work in [`agents/backroom-runtime`](agents/backroom-runtime). Its tests are synthetic and never call a paid model. |
| Report a wrong or unclear tool | Open an issue quoting the tool name from [`agents/mcp-contract`](agents/mcp-contract). |
| Improve how SPAWN plans and hires | Work in [`protocol`](protocol): coordinator prompts (as a new version), commissioning rules, workflow references, ComfyUI checks. |
| Improve clips | Work in [`services/clipper-modal`](services/clipper-modal). |
| Work on the token SDK | See [`spawn-token`](spawn-token). |

## Sign off your commits (DCO)

Every commit needs a `Signed-off-by` line. It certifies the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or otherwise have the right to submit it under this repository's license.

```sh
git commit -s -m "Describe the change"
```

Use your real name or your usual GitHub identity, and an email you control (a GitHub noreply address is fine). Pull requests whose commits are not signed off will fail the `dco` check. To fix older commits on your branch: `git rebase --signoff main`, then force-push your branch.

By contributing you agree your contribution is licensed under Apache-2.0, the same license as the rest of SPAWN-owned source.

## Checks

Run these commands from the repository root. The JavaScript checks require Node.js 24 or newer. For the clipper suite, use Python 3.11 with an active virtual environment, FFmpeg with libass, and the DejaVu fonts. [Clipper test setup](services/clipper-modal/README.md#local-check)

```sh
# Backroom proposals and catalogue (no dependencies)
node backrooms/check.mjs

# Mods (no dependencies)
node mods/check.mjs

# Agent runtime
(cd agents/backroom-runtime && npm ci --ignore-scripts && npm test && npm run check:types)

# Protocol
(cd protocol && npm ci --ignore-scripts && npm run check)

# Clipper
(cd services/clipper-modal && python -m pip install -r requirements-test.txt && python -m unittest discover -s tests)

# Token SDK
(cd spawn-token && npm ci --ignore-scripts && npm run check)
```

CI also runs connector checks, the Signal Below fixture, and package-specific builds and audits. Pull requests from first-time contributors wait for a maintainer to approve the read-only workflow run. [CI commands](.github/workflows/checks.yml)

## Resolved source findings

- Caption colors must be strings such as `"#FFFFFF"`. The checker now rejects color arrays, with regression tests for all three fields. [Contributor fix](https://github.com/Spawn-Backrooms/spawn/pull/6)
- CLIPS admission now claims a job ID before starting its worker, preventing duplicate starts for the same admitted job. [Contributor fix](https://github.com/Spawn-Backrooms/spawn/pull/29)
- A late analysis or render result cannot overwrite an acknowledged cancellation in the published implementation. [Contributor fix](https://github.com/Spawn-Backrooms/spawn/pull/8)
- The coordinator's explicitly selected `v2` prompt can describe one research step that also synthesizes its findings when only one step fits the budget. Default `v1` wording stays unchanged for retained work. This is a standalone helper contract; hosted caller adoption and release need their own qualification. [Contributor fix](https://github.com/Spawn-Backrooms/spawn/pull/7)

## Configuration and transport boundaries

The generated `spawn_configure_room` contract describes the five configurable room kinds; `config` remains optional for name, description, or brief-only updates. Empty research and video drafts remain valid. New writes allow at most 16 research questions or 32 video shots, while reading retained rooms, renaming them, and repairing oversized legacy configurations use the server's compatibility rules. A room schema by itself does not establish write authority or bypass revision checks. [Configuration discussion](https://github.com/Spawn-Backrooms/spawn/pull/19)

MCP's 65,536-byte HTTP limit applies to the complete serialized JSON-RPC request, including escaping and protocol fields. A graph that fits its argument schema can still exceed that transport limit. See the [request-size guidance](agents/mcp-contract/README.md#request-size).

## How your change reaches production

The private repository is the source of truth for exported files, including the root README and contributor guide. After public review, a maintainer ports accepted changes before the next export and keeps the commit author and sign-off. A hosted release follows its own review and verification. [Porting and export process](docs/porting-contributions.md)

The MCP contract in [`agents/mcp-contract`](agents/mcp-contract) is generated from the server source. Don't edit the JSON by hand; propose the change in an issue or pull request description and we'll make it in the server.

## Ground rules

- Never commit credentials, private keys, wallet seed phrases, bearer tokens or live RPC URLs. Push protection and secret scanning are on.
- Don't add fonts, images, models or other assets unless you made them or their license allows redistribution. Record third-party material in the package's `THIRD_PARTY_NOTICES.md`.
- Dependency changes need `npm audit` and a notices update.
- Keep honest status labels. Don't describe a connector, host or flow as working unless you verified it, and say how.
- Agents are welcome to contribute. A human must sign off the commit and is responsible for it.

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
