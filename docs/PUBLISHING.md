# 发布到 Paseo 插件市场

本项目采用 **公开 GitHub 源码 → 官方 submission Issue → 审核 PR → 市场收录**，不需要先发布 npm 包。已获授权使用公开仓库 [ketitongxue/paseo-codex-multi-account](https://github.com/ketitongxue/paseo-codex-multi-account)。创建仓库、推送源码和提交 Issue 都会公开内容；后续若更换 owner/repository 或发布其他内容，应再次确认授权。

官方规则：

- [发布指南](https://paseo.sh/docs/plugins/publishing)
- [市场审核政策](https://github.com/getpaseo/plugins/blob/main/REVIEW.md)
- [提交表单](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml)

## 已准备的材料

- `OVERVIEW.md`：英文默认市场介绍，不含插件安装命令。
- `OVERVIEW.zh-CN.md` 与 manifest `translations.zh-CN`：中文市场介绍与名称/描述。
- `assets/accounts-preview.png`：实际 `client/accounts.tsx` 在只读预览宿主中渲染，使用合成账号、无效示例邮箱和示例额度；不是生产 daemon 的运行验收截图。
- `npm-shrinkwrap.json`：由 npm 从原 lock 转换，可供 Git 安装与 npm 发布包统一使用；包含精确版本、来源与 integrity。唯一运行时依赖使用官方 npm tarball，integrity 已与官方元数据核对；开发依赖保留原锁文件中的镜像来源，未修改全局 npm registry 设置。
- manifest 的 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`：只安装锁定的运行时依赖，不执行依赖生命周期脚本。
- GitHub Actions：macOS / Linux、Node 22 / 24 的类型、lint、测试与归档预检。结果应按具体 commit 查看 [CI](https://github.com/ketitongxue/paseo-codex-multi-account/actions/workflows/check.yml)，不能把本机通过等同于矩阵已通过。
- `SECURITY.md`、`docs/RESEARCH.md`、`docs/VALIDATION.md`：权限、账号隔离设计和验证边界。

## 本地预检

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run screenshot
npm pack --dry-run --ignore-scripts
```

截图脚本需要已经安装的 Chrome/Chromium；macOS 默认使用 `/Applications/Google Chrome.app`，其他路径可通过 `CHROME_BINARY` 指定。它使用临时浏览器配置、只监听 loopback 的预览服务器、禁止外部连接的页面 CSP、合成数据和禁用的写操作，不访问真实 daemon、Codex home、keyring 或 Pi 配置，也不会下载浏览器。截图中的宿主适配层不进入发布包。

确认发布内容没有 `.research/`、node_modules、`.tgz`、用户配置、真实邮箱/路径、授权链接或凭据。测试中的 JWT、设备码和 `.invalid` 邮箱都是合成夹具，不是实际账号。首次公开前还应人工阅读将提交的 Git 文件列表，检查意外加入的文件。

当前验证尚未覆盖真实交互 OAuth、生产会话跨账号续接、手机视觉验收与 Linux 实机 keyring。市场介绍已明确披露，不应把自动测试或截图描述成这些场景已通过。

## GitHub 发布

1. 使用已确认的公开仓库 `ketitongxue/paseo-codex-multi-account`。
2. `package.json` 的 `repository`、`homepage` 与 `bugs` 应保持与公开仓库一致，依赖变化时同步 shrinkwrap。
3. 提交经过审阅的源码、测试、文档、图片与 shrinkwrap，推送到公开仓库。
4. 等待 CI 通过，建议创建 `v0.1.0` tag / release，并记录对应完整 commit SHA。不要对已经提交审核的 tag 强制移动。
5. 在独立测试 daemon 上从公开 Git URL 的该固定 revision 安装，确认 `running` 且无错误。不需要升级全局 CLI，不要为发布而重启用户生产 daemon。

Issue 正文模板见 [MARKETPLACE_SUBMISSION.md](MARKETPLACE_SUBMISSION.md)。提交时在正文补充 release tag 对应的完整 commit SHA、该 commit 的 CI 链接及隔离安装结果，不要以本机目录或本地 tgz 提交。

## 提交审核

打开官方表单，使用英文插件名称作为标题：

- **Source**：公开 GitHub 仓库/目录 URL，推荐携带 `tree/<完整 commit SHA>`，或在正文补充待审核 tag 与完整 SHA。
- **Categories**：优先 `Providers`，同时选择 `Sidebar` 和 `Utils`。插件管理现有 Codex 账号，不注册新的模型 provider；这些分类只是帮助发现。
- **Media**：manifest 已引用随仓库发布的 PNG，截图包含合成数据标识。

应通过表单创建 Issue，确保带有官方 `submission` label。机器人会打开审核 PR，审核方静态检查该 revision、安装输入、数据访问和展示材料。需要修改时在审核 PR 回复并提供新 revision；审核合并、市场发布后才算真正上架。不要仅因为 Issue 已提交就宣称已收录。

Git 路线后续版本需用新 revision 再提交更新审核；现有市场安装跟随已批准 pin，而不是自动追踪仓库 main。

## 如果以后选择 npm

先确认 npm scope/名称与公开发布授权，设置归属仓库信息。发布包必须包含 `npm-shrinkwrap.json`，不能依靠不会进入 npm 包的 `package-lock.json`。npm 获取包时已经安装运行时依赖，应从面向 npm 的 manifest 删除 Git 专用的依赖安装 `build`，避免重复安装。为不同分发方式准备 manifest 时，必须对最终实际发布的 artifact 重新预检和固定版本，不能修改已经发布的版本。

不要运行无版本审核的自动发布命令。本仓库的 CI 仅做检查，不自动执行 npm 发布、GitHub release 或市场 Issue 提交。
