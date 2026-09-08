# Pickpen Sync

[中文](#中文说明)

Pickpen Sync is a local-first cloud sync plugin for Obsidian. It keeps notes available in your local vault while synchronizing changes across desktop and mobile devices, preserving version history, and retaining conflict copies when concurrent edits cannot be merged safely.

> Pickpen Sync is an independent service and is not affiliated with or endorsed by Obsidian.

## Features

- Synchronizes vault files across desktop and mobile devices.
- Detects local and remote changes automatically.
- Preserves both versions as conflict copies instead of silently discarding concurrent edits.
- Provides per-file version history and restore controls.
- Supports multiple remote vaults under one account.
- Keeps your working copy in the local Obsidian vault.

## Important service and data disclosure

Pickpen Sync is a network-connected service. Before using it, please note:

- An account is required. Email verification is used for sign-in and registration.
- The plugin connects to Pickpen Sync servers to authenticate, manage subscriptions, and upload/download vault data for synchronization and version history.
- A limited free tier is available. Paid plans provide additional storage and capabilities; current terms are shown on the [Pickpen Sync website](https://www.pickpen.net/pricing) and at checkout.
- The support section loads a contact QR image from `rrecurengine.com` only when that section is displayed.
- The plugin does not include client-side analytics, advertising, self-updating code, or background telemetry. Diagnostic details are added only to a local email draft after you click **Email feedback**; you can review or remove them before sending.

For the complete data-handling description, see [Privacy Policy](PRIVACY.md).

## Installation

### Obsidian community plugins

Once Pickpen Sync is accepted into the community plugin directory:

1. Open **Settings → Community plugins → Browse** in Obsidian.
2. Search for **Pickpen Sync**.
3. Select **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the matching GitHub release.
2. Place them in `<your-vault>/.obsidian/plugins/pickpen/`.
3. Reload Obsidian and enable **Pickpen Sync** under **Community plugins**.

## Getting started

1. Open **Settings → Pickpen Sync**.
2. Enter your email address and request a verification code. A new account is created automatically on first sign-in.
3. Select an existing remote vault or create a new one.
4. Pickpen Sync performs the initial reconciliation and continues syncing while Obsidian is running.

The plugin excludes Obsidian configuration, trash, hidden files, and other internal paths by default. Additional exclusions can be configured in settings.

## Development

Requirements: Node.js 22.18 or later and npm.

```bash
npm ci
npm test
npm run typecheck
npm run build:prod
```

The generated TypeScript protobuf files under `src/gen/` are committed intentionally. Protocol source files are maintained in the private monorepo and are not distributed in this repository; building this repository does not regenerate them.

## Releases

`manifest.json` is the source of truth for the plugin version. Create a Git tag with exactly the same version value (for example, `0.1.0`). The release workflow verifies the tag, runs tests and type checking, builds the production bundle, and uploads `main.js`, `manifest.json`, and `styles.css` to a GitHub release.

## Support

- Website: [www.pickpen.net](https://www.pickpen.net)
- Email: [pickpen@rrecurengine.com](mailto:pickpen@rrecurengine.com)

## License

Pickpen Sync is released under the [MIT License](LICENSE). Third-party software remains subject to its respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## 中文说明

Pickpen Sync 是一款本地优先的 Obsidian 云同步插件。笔记的工作副本始终保留在本地 Vault 中，插件负责在桌面端与移动端之间同步改动、保留文件版本历史，并在无法安全合并并发修改时保留冲突副本。

> Pickpen Sync 是独立服务，与 Obsidian 官方无隶属或背书关系。

### 主要功能

- 在桌面端和移动端之间同步 Vault 文件。
- 自动检测本地及远端改动。
- 并发修改无法安全合并时保留双方内容，避免静默覆盖。
- 查看和恢复单个文件的历史版本。
- 一个账号可管理多个远端仓库。
- 本地 Obsidian Vault 始终保留可直接使用的工作副本。

### 重要服务与数据说明

- 使用 Pickpen Sync 必须登录账号，邮箱验证码用于登录和注册。
- 插件会连接 Pickpen Sync 服务器，完成认证、订阅管理、Vault 数据上传下载和版本历史功能。
- 服务提供有额度限制的免费方案；付费方案可获得更多存储空间与能力，具体条款以[官网价格页](https://www.pickpen.net/pricing)和结账页为准。
- 打开“关于与反馈”区域时，插件会从 `rrecurengine.com` 加载客服二维码图片。
- 插件不包含客户端统计分析、广告、自更新代码或后台遥测。只有在你点击“邮件反馈”后，插件才会在本地邮件草稿中加入诊断信息；发送前可自行检查或删除。

完整的数据处理说明见[隐私政策](PRIVACY.md)。

### 安装与使用

通过 Obsidian 社区插件目录安装后，在 **设置 → Pickpen Sync** 中输入邮箱并获取验证码；首次登录会自动注册。随后选择已有远端仓库或新建仓库，插件会进行首次对账并在 Obsidian 运行期间持续同步。

如需手动安装，请从同一 GitHub Release 下载 `main.js`、`manifest.json` 和 `styles.css`，放入 `<你的 Vault>/.obsidian/plugins/pickpen/`，重载 Obsidian 后启用插件。

### 开发

需要 Node.js 22.18 或更高版本：

```bash
npm ci
npm test
npm run typecheck
npm run build:prod
```

`src/gen/` 中的 TypeScript protobuf 生成物会直接提交。协议源文件仅在内部单体仓库维护，不随开源仓库发布，独立仓库构建时也不会重新生成协议代码。

### 支持与许可

- 官网：[www.pickpen.net](https://www.pickpen.net)
- 邮箱：[pickpen@rrecurengine.com](mailto:pickpen@rrecurengine.com)
- 许可证：[MIT](LICENSE)

如需人工支持，可扫描下方二维码添加客服微信：

<img src="https://rrecurengine.com/images/pickpen-contact.jpg" alt="Pickpen 客服微信二维码" width="260">
