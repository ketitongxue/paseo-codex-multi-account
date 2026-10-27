# 验证记录

环境：macOS / Node v26.8.2 / Codex CLI 0.164.0。开发与运行时目标均锁定 Paseo `0.14.0-beta.1`。开发期间未升级全局 CLI、未将插件安装到生产 daemon。

## 自动测试

`npm run check`：类型检查、Biome、Vitest（单 worker）。最新结果 **10 个测试文件、62 项测试全部通过**。使用临时目录与合成凭据，不触及用户 Pi、Codex 或 Paseo 配置。

覆盖：

- 自动发现、canonical 路径去重、保存、严格注册表、并发写、文件权限、损坏/重定向目录拒绝。
- 文件与 keyring 读取、认证过期、token 轮换、不得输出/复制 token、keyring 错误不得读陈旧文件；实际文件/符号链接目标大小上限与普通文件校验。
- 订阅额度解析、未知窗口、零 credits、专项窗口稳定 ID、401/403/429/HTML/网络错误、Retry-After、身份变化隔离、请求合并与并发上限；过期时停止返回缓存成功、无关 JSON 拒绝、错误 HTTP body 回收。
- Agent label/env/default 选择、已有绑定固定、Pi 不受影响、busy 拒绝、已有 Agent 显式接管、重载确认、失败回退与未确认状态拒绝续接；首开竞争不覆盖绑定、历史 hook 不作为切换确认、切换全程保护原/目标账号。缺少稳定身份不能绑定，过期账号不能设为默认。
- 删除外部账号不碰认证文件；默认/绑定账号不能删除；托管 home 官方 logout 与严格路径校验；释放绑定后禁止默认身份回落。
- 真实 Node 假 Codex 子进程的设备/浏览器登录、提前完成事件、错配事件、取消/超时、异常退出处理、非官方链接拒绝、进程回收；即使收到成功通知，keyring 缺失/过期/身份不明仍失败。不使用真实 OAuth。
- React 渲染账号/额度与删除确认、手动刷新、客户端命令注册和清理。
- **真实 Paseo beta 编译器**：编译双入口并校验跨运行时边界，拒绝 0.13.2。
- **真实 Paseo beta 插件子进程运行时**：加载本插件、typed RPC 输入验证、Usage Source 发现/过期报告、session-open 的 env/tools 通过实际 IPC 传输、Pi hook 不变、卸载清理。daemon SDK 连接使用最小测试宿主，不连接生产 daemon。
- **市场材料预检**：中英文 overview 不含插件安装命令、manifest 本地 PNG 引用、截图样例账号不含真实邮箱/目录、可发布 shrinkwrap 与依赖声明同步、preparation 锁定输入且禁用生命周期脚本。

CI 首轮暴露 npm 10 / Node 22 对 Vite 可选 esbuild peer 的锁文件兼容问题。已将项目开发用 esbuild 固定为 0.28.2，同时保留 Paseo SDK 自己的 esbuild 0.25.12；`npm ls esbuild --all` 无冲突，npm 10 的干净 `npm ci` 与本机 62 项测试再次通过。CI 另增加依赖图检查，最终矩阵状态以所发布 commit 的 Actions 记录为准。运行时依赖未改变。

## 发布包验证

`npm pack` 生成 `paseo-codex-multi-account-0.1.0.tgz`。最新归档含 28 个发布文件，包括中英文 overview、PNG 预览、发布文档及 `npm-shrinkwrap.json`；不含 `.research/`、测试/预览宿主源码、node_modules、Git 数据或真实认证文件。

解包到临时目录后使用空 npm cache 和官方 registry 执行 manifest 同款 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`。唯一运行时依赖为 `@iarna/toml@2.2.5`，其 integrity 已与官方 npm 元数据核对；未安装开发 SDK。真实 Paseo beta 编译器成功编译发布包的客户端与服务端入口，声明的图片、overview 与 shrinkwrap 均存在。验证后删除临时安装目录。

本文件记录本机与本地产物验证，不能把这些结果当作公开 Git revision 的安装验收或 CI 矩阵通过。macOS/Linux 与 Node 22/24 的实际结果请按具体 commit 查看 [GitHub CI](https://github.com/ketitongxue/paseo-codex-multi-account/actions/workflows/check.yml)；公开 revision 的隔离安装结果与完整 SHA 应记录在对应 GitHub Release 和市场审核 Issue 中。

## 本机只读 smoke

再次运行 `npm run smoke:homes -- --usage`：发现三个现有 CODEX_HOME，均返回有效的套餐、限额窗口与 credits。原先的网络失败场景也保持显示错误，未被伪装成 0% 使用量。

只读 smoke 不保存账号、不调用 login/logout、不启动真实 Codex app-server、不发模型 turn、不打印 token/email。额度会随外部实际使用变化，测试不固定其数值。私有临时日志在 git-ignored `.research/`，不进入发布包。

## 真实 Codex 协议 smoke

`npm run smoke:codex` 在真实 Codex CLI 0.164.0 上通过：stdio initialize 成功，`account/read` 返回未登录，未创建 auth.json，模型 turn 数为 0。临时 HOME、CODEX_HOME、XDG 与 TMP 隔离，命令行强制 ephemeral 认证并阻断外部 HTTP 代理连接；清理所有临时文件。不使用已有用户凭据或系统 keyring，不修改 Pi 配置。该测试验证真实协议兼容性，不等于真实 OAuth 验收。

## 市场界面预览

`npm run screenshot` 使用真实账号组件、React Native Web 与临时 Chrome profile 生成 `assets/accounts-preview.png`。两组账号、邮箱、路径及额度均为合成数据，图片明确标注 Synthetic data；已人工查看图片，确认包含账号管理、额度窗口、逐 Agent 切换与创建表单。预览不连接 daemon，不访问 Codex、keyring、用户配置或模型服务，写操作与剪贴板操作被禁用。此图仅证明当前界面的渲染，不是生产 OAuth 或真实会话续接验收。

## 未进行的验收

- 用户交互的真实 OAuth / OS Keychain 授权提示。
- 生产 Agent 的真实模型请求、跨账号会话续接、compaction、子会话和 rewind。
- iOS/Android 实机与 Electron 视觉验收、Linux 实机 keyring。

独立 home 无原生历史时切换拒绝是有意行为，不属于上下文迁移。关闭/卸载插件移除 hook 后，宿主普通默认认证行为重新生效；需要严格固定账号时应先停止或归档相关 Agent。
