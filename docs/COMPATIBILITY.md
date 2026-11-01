# Paseo 版本兼容性

## v0.1.1 的支持范围

manifest：`>=0.14.0-beta.1 <0.16.0`。daemon 和显示插件 UI 的客户端会分别检查版本，只更新其中一个不足以保证兼容。

| Paseo 版本 | SDK 类型检查 | 双入口编译 | 生产依赖隔离编译 | 插件子进程 / RPC / Usage / hook |
| --- | --- | --- | --- | --- |
| 0.14.0-beta.1 | 通过 | 通过 | 通过 | 通过 |
| 0.14.0-beta.2 | 通过 | 通过 | 通过 | 通过 |
| 0.14.0 | 通过 | 通过 | 通过 | 通过 |
| 0.15.0-beta.1 | 通过 | 通过 | 通过 | 通过 |

以上为真实 npm 版本，而不是向旧运行时传入不同版本字符串。开发基线保留最低版本 SDK；其他三个精确版本以开发依赖 alias 安装并锁在 shrinkwrap 中。`scripts/paseo-targets.ts` 从各 server 自己的依赖范围解析匹配的 plugin/client/protocol，校验真实 package version；`npm run compatibility` 对可发布代码逐版本做 TypeScript 检查。Vitest 逐版本运行真实编译器和对应 plugin-process 子进程。

这些开发依赖不会随 `npm ci --omit=dev` 的生产安装加载。运行时仍只有原有 TOML 解析依赖，没有变更 token 存储、注册表格式或账号迁移行为。

## 为什么不只修改版本上限

0.15 增加 `server.addHook("agent.open.before", handler)`，旧的 `before("agent.session_open", handler)` 仍作为兼容入口保留。兼容层按函数能力检测新 API，存在则只注册新 hook，否则只注册旧 hook；不会重复注册，也不会在新 API 拒绝注册时静默降级。清理函数原样返回。

回归通过真实 IPC 验证账号选择、CODEX_HOME、工具元数据、Usage Source、错误和卸载；Pi provider 不受影响。核心账号固定、切换失败回退、删除预约与凭据保密测试保持不变。

0.13 不具备本插件所依赖的完整 0.14 会话打开/工具行为，因此没有向下声称支持。0.16 及以上不在验证范围，仍拒绝加载。未来扩展范围前应增加对应精确 SDK、类型检查和运行时测试，而不是删除兼容上限。

## 从旧版本升级

v0.1.0 的 `<0.15.0` 拒绝 0.15.0-beta.1 是旧 manifest 的预期行为，不代表账号损坏，也不需要降级 Paseo 或改 Pi 配置。

- 本地目录安装：更新本目录到 v0.1.1 或后续版本，然后在插件列表重新加载该插件。
- 直接 Git 安装：使用插件列表的更新入口；需要精确版本时由兼容 CLI 指定 `--ref v0.1.1`。
- 市场安装：市场使用官方批准的固定 commit。GitHub 新版本发布不等于市场 pin 已更新，需等待对应更新审核通过，再在插件列表检查更新。
- 市场仍是旧 pin 时，可在桌面插件来源使用 `git:ketitongxue/paseo-codex-multi-account`。若提示相同 ID 已安装，先移除旧安装记录再按 Git 来源安装。移除插件不删除独立保存的账号元数据和 Codex home；但移除期间 hook 不存在，需要严格固定账号时先停止或归档相关 Agent。

不必升级全局 CLI，不要直接编辑市场缓存、旧 release tag 或原生认证文件来绕过检查。此更新不会自动升级/重启生产 daemon，也不修改 Pi 配置。
