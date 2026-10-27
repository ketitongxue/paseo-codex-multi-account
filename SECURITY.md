# Security

This is trusted, unsandboxed Paseo code running as the daemon user. It is not an OS sandbox or an isolation boundary between untrusted users/agents. Restrict access to the daemon and install only code and dependencies you trust.

## Credentials

- No access/refresh/ID token is persisted by this plugin, sent through plugin RPC, placed in agent labels/env, cached on disk or logged. Tokens read from an existing provider store live only in memory for a bounded HTTPS quota request. Credential fingerprints and stable account identity hashes remain non-secret cache metadata.
- New sign-in is performed by the official Codex CLI with strict `cli_auth_credentials_store="keyring"` and `auth_keyring_backend="direct"` overrides. The managed home also keeps those non-secret settings. There is no `auto`/file fallback, custom OAuth exchange, or plugin-managed encryption key.
- Existing external `auth.json` files may already contain plaintext credentials. They are read, not copied, rewritten, migrated or deleted. The plugin does not claim to encrypt these existing files. External credentials remain subject to the official CLI's own refresh/storage behavior when that CLI runs.
- Authenticated requests use a fixed HTTPS endpoint with redirects disabled, timeout and response-size bounds. Provider error bodies, raw CLI output and schema diagnostics are not returned to the client. Authorization links/device codes are transient and cleared on completion/cancel/timeout.
- macOS direct Keychain and Linux Secret Service are supported. Unsupported keyring backends or inaccessible secure storage fail closed. No fallback to a potentially stale file on a keyring error. Real interactive OS permission prompts still require user approval.

## Account selection

Session-open only sets the selected `CODEX_HOME`. It rejects known authentication/endpoint environment overrides, custom provider commands, missing homes, changed or unidentifiable stable account identities and unconfirmed switches. Locator-only usage discovery is not proof of identity for an Agent binding. It never substitutes another account because the chosen account is unavailable or exhausted.

Switches require an inactive agent and native history visibility in the target home. Both the target and previous accounts remain reserved until reload/rollback finishes; deletion, re-login and binding release cannot invalidate the in-flight operation. Only an interactive refresh hook confirms the selection; a history read does not. Reload is not atomic with messages from another client; do not send concurrently. The active binding confirms a successful host reload and observed session-open selection, not an independent native-process authentication receipt. Failed rollback remains unconfirmed. Released bindings leave a tombstone preventing accidental default-CLI fallback on resume.

Plugin disable/removal necessarily removes its hooks and tools; Paseo can then launch native sessions using its ordinary defaults. Stop/archive affected agents before disabling if you must preserve strict account pinning. Do not treat plugin disable as an authentication revocation mechanism.

## Files and deletion

Metadata uses private modes, serialized atomic writes and strict schema validation. Credential/config reads check the opened regular file, follow legitimate external symlinks without modifying them, and bound reads even when a target grows or a symlink points at a large file. Non-regular files are refused without a blocking FIFO read. Only plugin-created, path-validated managed homes can be purged, after explicit UI confirmation and official logout. The registry claims deletion before side effects to prevent concurrent binding. External deletion is hide/forget only. Registry and native history still contain private names/paths/conversation data; protect backups.

Do not modify the managed keyring settings or add workspace/system policies that override authentication storage. The plugin does not weaken administrator requirements or automatically rewrite project configuration. CLI-managed logs/history and other processes running as the same OS user are outside this plugin's security boundary.

No Pi configuration, Pi authentication store, global provider command or existing daemon configuration is modified by the project or its tests. Install/update/global plugin-enablement actions are left to the user. Use one plugin instance: the metadata registry is single-writer.

Report vulnerabilities privately with synthetic credentials and redacted account/path information; never attach real auth files, tokens, authorization URL queries or device codes to public issues.
