Manage several Codex/ChatGPT subscription accounts in Paseo without replacing the default Codex authentication files. Each account uses an independent `CODEX_HOME`. Reuse existing homes, create an OS-keyring-backed login, choose a default for new agents, or select an account for an individual Codex agent.

## Accounts and usage

- Discover the default Codex home, named homes such as `~/.codex-personal`, and the daemon's configured home. Other existing directories can be saved by path.
- Use the official Codex CLI for device-code or local-browser sign-in in plugin-managed homes. New sign-ins require strict direct keyring storage; failure does not fall back to a plaintext token file.
- Set a default for new agents, use the `codex/account` creation label, or switch an idle agent with `/codex-account`. Existing bindings do not follow subsequent default changes or automatically fall back when quota is exhausted.
- View account plans, provider-reported quota windows, reset times and credits in the account screen and Paseo's Usage Source. These are subscription limits, not session token counts or API billing.
- Forget an external account without deleting its files. A managed home can also be logged out and permanently removed after explicit confirmation, provided it is no longer the default or bound to an agent.

The interface preview uses synthetic accounts and usage. The account screen and operational errors currently use Simplified Chinese; the account-selection label and slash commands use the names above.

## Setup

Use Paseo daemon and client v0.14.0-beta.1, the version tested by this release, with Node.js 22.12 or newer and a separately installed official Codex CLI. The manifest permits the 0.14 series, but later releases have not been verified. Sign-in/protocol testing targets Codex CLI 0.164.0. The plugin does not install or download Codex for you.

The daemon needs macOS Keychain, or Linux Secret Service with `secret-tool`, for direct keyring storage. Linux keyring has not been verified on a real machine. Windows and Codex's encrypted `secrets` keyring backend are not supported. Browser sign-in must finish on the daemon's computer; device-code sign-in can finish on another device. Each account needs a ChatGPT subscription usable by Codex; API-key accounts are not supported.

## Data and permissions

This is trusted, unsandboxed code running as the daemon user. It reads the selected homes' configuration and existing authentication files or direct OS-keyring entries. Existing plaintext authentication files are read only: the plugin does not encrypt, copy or migrate them. Official Codex processes can still maintain their own credentials, logs and history.

Opening the account screen automatically reads the discovered accounts and queries their usage, polling once per minute while the screen is mounted. Paseo's Usage views can also invoke the source. Successful usage reads are cached in memory for up to five minutes, bounded by token expiry; manual refresh still respects error backoff. Keyring reads may require an OS permission prompt.

Quota collection sends the selected access token and ChatGPT account ID only to `https://chatgpt.com/backend-api/wham/usage`. It does not exchange refresh tokens or create model turns. Login uses the official CLI and OpenAI authorization pages. Normal agent messages still go through the selected Codex account to its provider.

Paseo clients receive account names, home paths, email addresses, plans, usage and binding status. Transient login links and device codes are visible in the sign-in dialog and are cleared on completion, cancellation or timeout. Tokens are not included in plugin RPC responses or written to plugin metadata. Metadata under the daemon's Paseo home contains paths, names, default selection and bindings; usage caches stay in memory.

Codex agents receive a `codex_accounts` tool that can return account IDs/names, sign-in status, plans and optional usage. That tool result may be included in the agent's model context and sent to its provider. It does not return tokens or email addresses.

## Switching limitations

A target home must be able to read the same native Codex thread before an existing chat can switch. If its history is separate, create a new agent under the target account or arrange shared history yourself. The plugin does not move history or substitute an empty conversation.

Switching reloads the idle agent and attempts rollback on failure. Paseo does not provide an atomic idle-and-reload operation, so do not send messages from another client during a switch. Confirmation covers the host reload and observed account selection, not an independent native-process authentication receipt. A missing, expired, changed or unidentified account is refused rather than replaced by another account.

The plugin does not change Pi configuration or provider launch commands. Disabling it removes its session hooks, after which ordinary host authentication defaults apply; stop or archive pinned agents before disabling when strict account selection must be preserved. Real interactive OAuth, production conversation switching and mobile visual acceptance remain unverified.
