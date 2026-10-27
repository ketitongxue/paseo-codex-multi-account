# Marketplace submission template

Release source and scope for the official submission form. Before posting, verify that the tag exists and append its full commit SHA, matching CI URL and isolated installation result. A submission is not a registry approval.

Suggested title: **Codex multi-account**

### Source

https://github.com/ketitongxue/paseo-codex-multi-account/tree/v0.1.0

### Categories

- [x] Providers
- [x] Sidebar
- [x] Utils

### Additional context

This plugin manages Codex/ChatGPT subscription accounts in independent `CODEX_HOME` directories. It supports discovery and reuse of existing homes, official CLI sign-in with strict direct OS-keyring storage for new managed accounts, per-agent selection and idle switching, and account quota display through a screen and Paseo Usage Source.

The repository includes English and Simplified Chinese overviews, a PNG interface preview using synthetic data, an npm shrinkwrap with exact dependency sources/integrity, and a preparation command using `npm ci --omit=dev --ignore-scripts`. The preview renders the current account component; it is not evidence of live OAuth or production conversation switching.

Data access, the fixed OpenAI quota endpoint, transient login information, agent-tool results that can reach model context, and deletion behavior are documented in the overviews and SECURITY.md. The plugin does not modify Pi configuration or replace provider launch commands.

Target tested Paseo release: v0.14.0-beta.1. The UI currently uses Simplified Chinese. macOS direct Keychain is the primary daemon platform; Linux Secret Service is implemented but not real-machine verified. Windows and the Codex encrypted secrets backend are not supported.

Existing chat switching requires the target home to see the same native thread. It is refused when history is isolated; no empty conversation is silently substituted. Real interactive OAuth, production conversation switching and mobile visual acceptance remain unverified.

Before submitting, append the actual release commit SHA, CI URL and isolated installation result. Use the official form so the issue receives the `submission` label that starts intake. Opening an issue does not mean the plugin has been approved or published.
