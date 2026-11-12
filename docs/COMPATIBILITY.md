# Paseo 版本兼容性

## v0.1.2 的支持范围

manifest：`>=0.14.0-beta.1 <0.17.0`。daemon 和显示插件 UI 的客户端分别检查版本，两者均需满足。

| Paseo 版本 | SDK 类型检查 | 双入口编译 | 生产依赖隔离编译 | 插件子进程 / RPC / Usage / hook |
| --- | --- | --- | --- | --- |
| 0.14.0-beta.1 | 通过 | 通过 | 通过 | 通过 |
| 0.14.0-beta.2 | 通过 | 通过 | 通过 | 通过 |
| 0.14.0 | 通过 | 通过 | 通过 | 通过 |
| 0.15.0-beta.1 | 通过 | 通过 | 通过 | 通过 |
| 0.15.4 | 通过 | 通过 | 通过 | 通过 |
| 0.16.0-beta.1 | 通过 | 通过 | 通过 | 通过 |
| 0.16.0-beta.2 | 通过 | 通过 | 通过 | 通过 |

以上为真实 npm 版本，不是向旧运行时传入不同版本字符串。开发基线保留最低版本 SDK；另外六个精确版本以开发依赖 alias 安装并锁在 shrinkwrap 中。`scripts/paseo-targets.ts` 从各 server 自己的依赖范围解析匹配的 plugin/client/protocol 并校验 package version；`npm run compatibility` 对可发布代码逐版本做 TypeScript 检查。Vitest 逐版本运行真实编译器与对应 plugin-process 子进程。

开发依赖不随 `npm ci --omit=dev` 的生产安装加载。运行时仍只有原有 TOML 解析依赖，没有更改 token 存储、注册表格式或迁移账号。

## API 与回归检查

- 有新 lifecycle API 的宿主使用 `addHook("agent.open.before", handler)`，老宿主使用 `before("agent.session_open", handler)`。按能力检测，只注册一次，不会在新 API 拒绝注册时静默降级；保留 this 和原样清理函数。
- 0.16 新增只读会话 metadata 和后台 Agent 标记。通过真实 IPC 验证这些字段在账号环境注入、非 Codex provider 及重载恢复时保持不变，避免丢失其他插件数据或改变 Agent 可见性。
- 0.16 的客户端引用/Composer API 为扩展接口，原有创建、导航及重载 API 保持兼容；本插件不要求或改写新 Composer 控件。Usage Source 核心合同保持一致。
- 逐版本测试账号选择、CODEX_HOME、工具元数据、Usage Source、错误与卸载/重载绑定保留；账号固定、失败回退、删除预约与凭据保密测试保持不变，Pi provider 不受影响。

0.13 缺少本插件依赖的完整 0.14 会话打开/工具行为，因此不声称向下兼容。未经验证的 0.17+ 仍拒绝加载。后续扩展前应增加精确 SDK 与真实运行时测试，而不是删除兼容上限。

## 从旧版本升级

v0.1.0 的 `<0.15.0`、v0.1.1 的 `<0.16.0` 拒绝较新 daemon 属于旧 manifest 的预期行为，不代表账号损坏，也无需降级 Paseo 或修改 Pi 配置。

- 本地目录：更新到 v0.1.2 或后续版本，然后在插件列表重新加载。
- 直接 Git：使用插件列表的更新入口；兼容 CLI 可用 `--ref v0.1.2` 指定精确版本。
- 市场：市场安装使用官方批准的固定 commit，GitHub release 不会自动推进市场 pin。更新审核通过后在插件列表检查更新。
- 市场还未同步时，可在桌面插件来源使用 `git:ketitongxue/paseo-codex-multi-account`。若提示相同 ID 已安装，先停止/归档需要严格固定账号的 Codex Agent，再移除旧插件安装记录并按 Git 来源安装。移除插件不删除独立的账号元数据或 Codex home，但移除期间没有 hook。

不必升级全局 CLI，不要编辑市场缓存、移动旧 release tag 或改写原生认证文件来绕过检查。本更新不会自动升级/重启生产 daemon，也不修改 Pi 配置。完整公开 revision 安装验收及 CI 链接见对应 GitHub Release。
