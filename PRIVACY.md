# Pickpen Sync Privacy Policy / 隐私政策

Effective date: September 7, 2026 / 生效日期：2026 年 9 月 7 日

## English

### Scope

This policy describes data handled by the Pickpen Sync Obsidian plugin and the Pickpen Sync cloud service.

### Data processed

To provide the service, Pickpen Sync processes:

- Account and session data: email address, user identifier, access/refresh tokens, device identifier, and plugin version.
- Sync data: remote vault identifiers and names; file paths, file contents, content hashes, timestamps, file identifiers, snapshot metadata, and retained version history.
- Subscription data: plan, usage, storage limits, order identifiers, payment status, and related transaction metadata. Payment credentials are handled by the payment provider and are not entered into the plugin.
- Operational server logs: source IP address, request method/path, plugin version, duration, result/error code, internal account/vault/order identifiers, and subscription/payment event metadata such as plan, amount, and status. Request/response bodies, authorization metadata, email addresses, synchronized file paths or contents, SQL statements/parameters, payment URLs, and raw error messages are not intentionally logged. The one exception is the setup-guide event described below, where the event name and stage are recorded. Rotated application logs are retained for up to 30 days.

### Storage and transmission

The local working copy remains in your Obsidian vault. Login tokens, email address, user/device identifiers, and limited alert state are stored in device-local browser storage. Vault binding and plugin preferences are stored in the plugin's `data.json`; synchronization base/pending state and temporary files are stored in the plugin directory.

Network traffic uses HTTPS. Synced file paths and contents are stored in plaintext at rest by the service, unless you choose to protect a vault with end-to-end encryption (see below). Pickpen Sync does not encrypt vaults by default.

### End-to-end encryption (opt-in per vault)

You can enable end-to-end encryption when creating a vault, or convert an existing vault later. In an encrypted vault:

- File contents (notes, images, attachments, and the versions created after encryption was enabled) are encrypted on your device before upload. The service stores only ciphertext and cannot read or recover it.
- The vault password is never uploaded and is not linked to your account. It is used locally to unwrap the vault's content key, which is stored on the service only in wrapped (encrypted) form. Because of this, **a forgotten vault password means the vault contents cannot be recovered by anyone, including us.**
- The service still stores and can read vault metadata: vault name, file paths, file types, sizes, timestamps, version relationships, and content hashes of the encrypted blobs.
- Changing the vault password only re-wraps the content key; it does not re-encrypt existing contents, so ciphertext written before the change remains readable with the same content key.
- Versions created before a vault was converted to encrypted remain stored in plaintext.
- Old clients that do not support encrypted vaults are rejected by the service for those vaults.
- Local files in your Obsidian vault stay in plaintext so Obsidian can read them normally.

If you enable "Remember password on this device", the content key is stored in device-local browser storage. Anyone with access to that device and its local storage can decrypt the vault's contents; leave this off on shared machines.

### Service providers and external requests

Pickpen Sync uses infrastructure and service providers including Tencent Cloud Object Storage and Simple Email Service, and Alipay for supported payments. The support section may load a contact QR image from `rrecurengine.com`. These providers process data under their own terms and privacy policies.

### Analytics and diagnostics

The plugin contains no client-side analytics, advertising, or automatic telemetry. The single outbound report is one anonymous event sent when the setup guide is displayed after you enable the plugin; it carries only the event name and the guide stage, with no email address, device identifier, vault information, or note content. When diagnostic logging is enabled, the plugin records only its own deliberately emitted, minimized logs in memory. It does not intercept global console output. Clicking **Email feedback** creates a local email draft containing account/device context and, if enabled, recent diagnostic logs. Nothing is sent until you review and send that email.

### Retention, deletion, and contact

Sync data and version history are retained while needed to provide your account and plan. You can delete unbound remote vaults from the plugin. To request account/data deletion or ask privacy questions, email [pickpen@rrecurengine.com](mailto:pickpen@rrecurengine.com).

## 中文

### 适用范围

本政策说明 Pickpen Sync Obsidian 插件与 Pickpen Sync 云服务如何处理数据。

### 处理的数据

- 账号与会话：邮箱、用户标识、访问/刷新令牌、设备标识和插件版本。
- 同步数据：远端仓库标识和名称，以及文件路径、文件内容、内容哈希、时间戳、文件标识、快照元数据和保留的版本历史。
- 订阅数据：方案、用量、存储限额、订单标识、付款状态及相关交易元数据。付款凭据由支付服务商处理，不会在插件中输入。
- 服务端运行日志：来源 IP、请求方法/路径、插件版本、耗时、结果/错误码、内部账号/仓库/订单标识，以及方案、金额、状态等订阅付款事件元数据。系统不会有意记录请求/响应正文、认证元数据、邮箱、同步文件路径或内容、SQL 语句/参数、付款链接或原始错误信息；唯一例外是旧版本插件可能上报的事件名与阶段（当前版本已不再上报任何事件）。轮转后的应用日志最长保留 30 天。

### 本地存储、传输和云端存储

笔记工作副本保留在本地 Obsidian Vault。登录令牌、邮箱、用户/设备标识及少量提醒状态存放在设备本地浏览器存储中；Vault 绑定和插件偏好存放在插件 `data.json`；同步基线、待恢复状态和临时文件存放在插件目录。

网络传输使用 HTTPS。同步的文件路径和内容默认在服务端以明文形式存储；你可以按仓库选择开启端到端加密（见下），未开启时服务端可读文件内容。

### 端到端加密（按仓库选择开启）

创建仓库时可以选择开启端到端加密，已存在的仓库也可以随后转换。加密仓库中：

- 文件内容（笔记、图片、附件，以及开启加密之后产生的历史版本）在本机加密后再上传，服务端只保存密文，无法读取或恢复。
- 仓库密码不会上传，也不与账号绑定；它只在本机用于解开仓库的内容密钥，而内容密钥在服务端只以被包装（加密）的形态保存。因此**忘记仓库密码后，仓库内容无法被任何人恢复，包括我们**。
- 服务端仍然会保存并可读取仓库的元数据：仓库名、文件路径、文件类型、大小、时间、版本关系，以及密文内容的哈希。
- 修改仓库密码只重新包装内容密钥，不会重新加密已有内容，因此改密码前写入的密文仍可用同一内容密钥解开。
- 仓库转换为加密之前产生的历史版本仍以明文保存。
- 不支持加密仓库的旧版客户端会被服务端拒绝访问该仓库。
- 本地 Obsidian Vault 中的文件始终是明文，保证 Obsidian 可正常读取。

「在本设备记住仓库密码」默认开启：仓库密码与其解出的内容密钥都会保存在设备本地浏览器存储中，重启后无需再次输入，并可在仓库管理中查看密码。该开关可随时关闭，关闭时会一并清除本机保存的密码与密钥。能访问该设备及其本地存储的人可以解密仓库内容，共用设备时请关闭此开关。

### 服务商与外部请求

Pickpen Sync 使用的基础设施和服务商包括腾讯云对象存储、腾讯云邮件服务，以及用于部分付款的支付宝。“关于与反馈”区域可能从 `rrecurengine.com` 加载客服二维码图片。相关服务商会依据各自条款和隐私政策处理数据。

### 统计与诊断

插件不包含客户端统计分析、广告或自动遥测，也不会上报任何事件。开启调试日志后，只会在内存中记录插件主动输出的精简日志，不会拦截全局控制台。点击“邮件反馈”会在本地生成包含账号/设备上下文的邮件草稿；仅在调试日志已开启时附带最近日志。你检查并主动发送前，不会传出这些诊断信息。

### 保留、删除与联系

同步数据和版本历史会在提供账号及订阅服务所需期间保留。你可以在插件中删除未绑定的远端仓库。如需申请删除账号/数据或咨询隐私问题，请联系 [pickpen@rrecurengine.com](mailto:pickpen@rrecurengine.com)。
