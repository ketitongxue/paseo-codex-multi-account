# Paseo compatibility

[简体中文](COMPATIBILITY.zh-CN.md)

## Supported versions in v0.2.0

The manifest requires `>=0.14.0-beta.1 <0.18.0`. The daemon and the client displaying the plugin UI each check their own version.

| Paseo version | SDK types | Both entry points compile | Production-only dependency build | Plugin subprocess, RPC, Usage, and hooks |
| --- | --- | --- | --- | --- |
| 0.14.0-beta.1 | Pass | Pass | Pass | Pass |
| 0.14.0-beta.2 | Pass | Pass | Pass | Pass |
| 0.14.0 | Pass | Pass | Pass | Pass |
| 0.15.0-beta.1 | Pass | Pass | Pass | Pass |
| 0.15.4 | Pass | Pass | Pass | Pass |
| 0.16.0-beta.1 | Pass | Pass | Pass | Pass |
| 0.16.0-beta.2 | Pass | Pass | Pass | Pass |
| 0.16.2 | Pass | Pass | Pass | Pass |
| 0.17.1 | Pass | Pass | Pass | Pass |

Checks use the published npm packages for each version. Development uses the oldest supported SDK as its baseline and installs the other eight versions as aliases pinned in the shrinkwrap. `scripts/paseo-targets.ts` resolves each server's matching plugin, client, and protocol packages and checks their package versions. `npm run compatibility` type-checks publishable code against each SDK, and Vitest runs each release's compiler and plugin subprocess.

`npm ci --omit=dev` excludes compatibility-test packages. TOML parsing remains the sole runtime dependency. v0.2.0 retains the existing token storage and registry format, so accounts require no migration.

## API and regression coverage

- Hosts with the newer lifecycle API use `addHook("agent.open.before", handler)` and `addHook("agent.turn.after", handler)`. Older hosts use `before("agent.session_open", handler)` and `on("agent.turn_ended", handler)`. The plugin detects which API is available and registers each handler once. Registration errors from the new API surface directly. The plugin preserves the receiver and cleanup callbacks.
- Paseo 0.16 added read-only session metadata and a background-agent flag. Paseo 0.17 added optional `appendSystemPrompt` to session open requests and removed the deprecated empty `timeline` field from `agent.turn.after`. The plugin does not read that field. IPC tests verify metadata, the background flag, and `appendSystemPrompt` when injecting account environments, handling non-Codex providers, and restoring bindings after reloads.
- The client reference, Composer, Worktree Manager, and Workspace Row Badge APIs added in 0.16 and 0.17 extend the existing client API. Agent creation, navigation, and reload remain compatible. The core Usage Source contract remains compatible with the optional `durationSeconds`, `observedAt`, `launch`, and `provider` fields introduced in 0.17.
- Tests cover account selection, `CODEX_HOME`, tool metadata, Usage Source, errors, and saved bindings after unload and reload for each version. Regression tests cover account pinning, rollback, deletion reservations, credential confidentiality, and preserving the Pi provider environment.

Paseo 0.13 lacks the session-open and tool behavior this plugin uses. Unverified 0.18 and later versions are outside the manifest range. Expanding the range requires pinned SDK and runtime checks for the added versions.

## Upgrade from an earlier release

v0.1.0 capped support below 0.15.0, v0.1.1 below 0.16.0, and v0.1.2 below 0.17.0. If an older plugin refuses to load on a newer daemon, update the plugin to a version that supports that daemon.

- **Local installation**. Update the source to v0.2.0 or later, then reload the plugin from the plugin list.
- **Direct Git installation**. Update from the plugin list. A compatible CLI can select an exact release via `--ref v0.2.0`.
- **Marketplace installation**. The marketplace installs a reviewed, pinned commit. Check for updates in the plugin list after the new revision is approved.
- **While a marketplace update is pending**. Use `git:ketitongxue/paseo-codex-multi-account` in the desktop plugin sources. If Paseo reports that the same ID is already installed, stop or archive agents that require strict account pinning before removing the existing plugin installation and switching to the Git source. Removing the installation preserves separate account metadata and Codex homes. Session hooks are unavailable while the plugin is removed.

Updating the plugin leaves the global CLI, production daemon, native credentials, and Pi configuration intact. Installation checks for the public revisions and CI links are recorded in the corresponding [GitHub releases](https://github.com/ketitongxue/paseo-codex-multi-account/releases).
