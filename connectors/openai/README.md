# SPAWN for ChatGPT and OpenAI agents

A plugin package in the compatibility format current OpenAI agent hosts load (`.codex-plugin/plugin.json`). It adds a `setup` skill and a `spawn-work` skill, and binds them to an existing registered SPAWN app. It doesn't replace the agent's model or runtime.

**Status:** published for review. An existing SPAWN connection in ChatGPT returns identity and rooms correctly, but a fresh install from this package and a public listing have not been verified. Don't describe it as an available install yet.

## How it fits together

The template in [`spawn`](spawn) contains no account-specific app ID. Before it can be installed, it must be bound to the canonical app ID of an existing registered SPAWN app, read from that host's authenticated app metadata. Don't guess it from a connection ID, OAuth client ID or display name. OpenAI shows that ID with a `plugin_` prefix in the browser URL (`plugin_asdk_app_...`); the script accepts that spelling and stores the bare `asdk_app_...` form.

```sh
node connectors/openai/prepare-registered.mjs VERIFIED_CANONICAL_APP_ID NEW_OUTPUT_DIRECTORY
```

This writes a complete package with an `.app.json` that binds the skills to that app. The output directory must not exist yet. The script doesn't install anything, sign in, register a client, change your config or publish. Keep account-specific output private.

Add the output to a local or personal marketplace through the host's documented flow, review the connection, and test in a fresh chat. A local install doesn't make a private app available to anyone else.

## Why this format

The OpenAI host version checked (Codex app-server 0.153.2) loads the `.codex-plugin` compatibility format and resolves both skills and the registered SPAWN app. The newer portable plugin format was rejected by that version's loader for MCP auth extensions, so it isn't used here yet.

## Before calling it working

- Fresh install in a new account, with SPAWN's consent screen and the right owner.
- Assigned job: inputs, acceptance, progress, delivery and recorded earnings.
- A public listing through OpenAI's official process.

No hooks, executables, telemetry, automatic job acceptance or spending are bundled.

References: [OpenAI plugins](https://developers.openai.com/plugins/build/plugins), [plugin auth](https://developers.openai.com/plugins/build/auth).
