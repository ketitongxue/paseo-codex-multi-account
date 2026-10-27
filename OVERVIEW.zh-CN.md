在 Paseo 中管理多个 Codex/ChatGPT 订阅账号，无需替换默认 Codex 认证文件。每个账号使用独立 `CODEX_HOME`，可以复用已有目录、创建系统 keyring 登录、为新 Agent 设置默认账号，或为单个 Codex Agent 指定账号。

## 账号与额度

- 自动发现默认 Codex home、`~/.codex-personal` 等命名目录和 daemon 配置的 home；其他已有目录可按路径保存。
- 在插件托管 home 中通过官方 Codex CLI 进行设备码或本机浏览器登录。新登录强制 direct keyring 存储，失败不回落到明文 token 文件。
- 设置新 Agent 的默认账号，通过创建 label `codex/account` 指定账号，或用 `/codex-account` 切换空闲 Agent。已有绑定不跟随默认值变化，额度用尽也不自动回落到其他账号。
- 在账号页面与 Paseo Usage Source 中查看套餐、服务端报告的额度窗口、重置时间和 credits。这些是订阅限额，不是会话 token 统计或 API 账单。
- 忘记外部账号不会删除其文件。托管 home 在取消默认并解除所有 Agent 绑定后，可以明确确认注销和永久删除。

界面预览使用合成账号和额度。账号页面与操作错误目前使用简体中文，账号 label 和斜杠命令使用上述名称。

## 使用条件

本版本验证了 Paseo daemon 与客户端 v0.14.0-beta.1，要求 Node.js 22.12 或更新版本，以及另行安装的官方 Codex CLI。manifest 允许 0.14 系列，但尚未验证后续版本；登录和协议测试目标为 Codex CLI 0.164.0。插件不会替你下载或安装 Codex。

daemon 需要 macOS Keychain，或配备 `secret-tool` 的 Linux Secret Service，使用 direct keyring 存储。Linux keyring 尚未经过实机验证，不支持 Windows 与 Codex 加密 `secrets` keyring 后端。浏览器登录必须在 daemon 所在电脑完成回调，设备码登录可以在其他设备完成。各账号需要可供 Codex 使用的 ChatGPT 订阅，不支持 API-key 账号。

## 数据与权限

插件是以 daemon 用户身份运行的受信任、无沙箱代码，会读取所选 home 的配置和现有认证文件或 direct OS-keyring 条目。已有明文认证文件仅被读取，不会被插件加密、复制或迁移。官方 Codex 进程仍可能自行维护凭据、日志和历史。

打开账号页面会自动读取发现的账号并查询额度，页面保持挂载时每分钟轮询一次；Paseo 的 Usage 视图也可调用该来源。成功结果仅在内存缓存最多五分钟，且不跨越 token 过期时间；手动刷新仍遵守错误退避。读取 keyring 可能触发操作系统权限提示。

额度查询仅将所选账号的 access token 和 ChatGPT account ID 发送到 `https://chatgpt.com/backend-api/wham/usage`，不兑换 refresh token，不创建模型 turn。登录使用官方 CLI 与 OpenAI 授权页面。正常 Agent 消息仍通过所选 Codex 账号发送到其服务商。

Paseo 客户端可见账号名称、home 路径、邮箱、套餐、额度与绑定状态；临时授权链接和设备码在登录弹窗展示，并在完成、取消或超时后清除。token 不会进入插件 RPC 响应或插件元数据。daemon 的 Paseo home 下保存的元数据仅包含路径、名称、默认选择和绑定；额度缓存仅驻内存。

Codex Agent 可调用 `codex_accounts` 工具，获取账号 ID/名称、登录状态、套餐及可选额度。工具结果可能进入 Agent 的模型上下文并发送给其服务商，不包含 token 或邮箱。

## 切换限制

已有聊天切换前，目标 home 必须能读取同一原生 Codex thread。如果历史相互独立，请用目标账号新建 Agent，或自行配置共享历史。插件不搬移历史，也不会用空白会话替代原上下文。

切换会重载空闲 Agent，失败时尝试回退。Paseo 没有原子的“检查空闲并重载”操作，切换期间不要从另一客户端发消息。确认仅覆盖宿主重载及观察到的账号选择，不是独立的原生进程认证回执。账号丢失、过期、身份变化或身份不可识别时会拒绝启动，而不是替换为其他账号。

插件不修改 Pi 配置或 provider 启动命令。禁用后会移除会话 hook，普通宿主认证默认行为重新生效；需要严格固定账号时，应先停止或归档相关 Agent。真实交互 OAuth、生产聊天跨账号切换和手机视觉验收仍未完成。
