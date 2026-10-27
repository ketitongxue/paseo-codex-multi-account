# 研究与开发计划

研究基线：Paseo `v0.14.0-beta.1` / `4495bda146c8fa0e84f50b56b26048fa9e3fdf3b`；account-switcher `v0.7.1` / `8f67b61b80ca9533d179c31b1ac109468f0f0de9`；本机 Codex CLI `0.164.0`。

## 查阅的上游接口

- Paseo `docs/plugins.md`、`public-docs/plugins/reference.md`：双运行时边界、typed RPC、before hooks、Usage Source、UI、安装与清理。
- `packages/plugin/src/server/{contracts,lifecycle,usage,agent-tools}.ts`：session_open 可修改 launch-only env，labels 可读；异常会使打开失败；hook 有 30 秒截止。
- `packages/client/src/index.ts`：0.14 `agents.ref(id).reload()` 是重开，`refresh()` 只是读取。不能混用。
- `plugins/codex-usage-source/server/usage.ts`：只读 ChatGPT `/backend-api/wham/usage`，全局发现与会话发现隔离；不兑换 refresh token；窗口名称依据响应 duration。
- account-switcher `docs/architecture.md`、`SECURITY.md`、`server/{profiles,switching,auth,login}.ts`：路径隔离、busy 检查、失败回退、进程回收、身份对应缓存。其 Codex managed profiles 强制 file 存储，与本项目不明文存储的目标不一致，不复用该实现。
- Codex `rust-v0.164.0` 的 `codex-rs/login/src/auth/storage.rs`、`config/src/types.rs`：keyring 严格模式失败不回落文件；macOS/Linux direct 命名为 service `Codex Auth`，account `cli|sha256(canonical CODEX_HOME)[0:16]`。auto 模式可能回落明文，不用于新登录。

## 架构决策

1. 不改 provider command、不复制 auth.json、不修改 Pi；用会话 hook 注入 home。
2. 注册表只保存路径、名称、默认值、Agent 选择及删除抑制列表。managed home 写入不含秘密的 keyring 配置；由官方 CLI 完成登录。
3. 外部 home 自动发现且只读。删除外部账号是“忘记/隐藏”，不 logout、不删除用户文件；新登录仅在插件创建的 home 内进行。
4. Usage Source 严格只读，token 仅驻内存，HTTP 错误/解析错误不返回响应正文；UI 复用相同实现，缓存绑定凭据指纹及身份，有限并发与退避。
5. Agent label `codex/account` 与创建 env `PASEO_CODEX_ACCOUNT` 可指定账号；首开保存绑定，后续 resume/refresh 不跟随默认值变化。
6. reload 前检查 idle、账号可用及原生 thread 可见性；隔离历史不可见则拒绝，不创建空白替代会话。原生重开与另一客户端发消息之间仍非原子操作。

## 实施顺序

先账号存储/发现与安全凭据读取，再 Usage、登录进程、逐 Agent 选择、RPC/UI，最后合成凭据测试、真实版本编译/子进程集成及只读本机 smoke。所有可写验证位于临时目录；不安装到生产 daemon。

## 续作复核与修复

在原有 40 项测试基础上，先添加回归测试复现问题，再修复：

- 切换过程中同时保留原账号与目标账号预约；禁止删除、重新登录或释放仍在切换的绑定。只有 `reason=refresh` 且 `purpose=interactive` 的 hook 可确认重开。
- 并发首开在串行注册表事务中复查绑定，不覆盖另一请求已保存的身份。缺少稳定 ChatGPT account ID 时允许只读额度发现，但不允许固定 Agent；支持 JWT 根层与 namespaced account ID。
- 额度成功缓存不跨越 access token 过期；拒绝不含额度协议字段的 200 JSON；取消未消费的 HTTP 错误响应体，不读取诊断正文。
- 文件读取检查实际打开的普通文件，而非符号链接本身的长度；即使文件增长也最多读取 1 MiB + 1 字节；非阻塞打开后拒绝 FIFO 等特殊文件。
- 新增 `smoke:codex`：真实 CLI 在一次性 HOME / CODEX_HOME 中使用 ephemeral 认证，验证 initialize 与 account/read；不运行 OAuth、keyring 登录或模型 turn，不继承用户凭据环境。

这些边界修复不改变“独立 home 不自动迁移原生历史”的设计，也不改动用户 Pi 配置或生产 daemon。

上游链接：
- https://github.com/getpaseo/paseo/tree/v0.14.0-beta.1
- https://github.com/dutchakdev/paseo-plugin-account-switcher/tree/v0.7.1
- https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/login/src/auth/storage.rs
