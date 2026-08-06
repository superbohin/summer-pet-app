# PWA + CloudBase 家庭同步配置

本方案把 CloudBase 作为家庭设备之间的同步传输层，PWA 仍在 GitHub Pages
运行。每台设备继续以 IndexedDB 保存完整本地数据；云端只保存：

- 根设备签名的家庭配置；
- 设备申请中的设备公钥、期望角色、设备名称和时间；
- 设备签名的加密事件。

任务内容、打卡历史、金币、兑换记录等业务正文仍在 AES-GCM 密文中。云函数只校验
ECDSA 签名、设备是否获批、角色和操作权限，不能解密业务正文。CloudBase 的
Publishable Key 可以放在浏览器构建配置里；腾讯云账号密码、SecretId、SecretKey、
服务端 API Key 绝对不能放入代码、GitHub 或发给协作者。

## 需要注册并提供的三个值

注册/控制台入口：<https://tcb.cloud.tencent.com/dev>

创建环境后，只需向应用配置者提供：

1. **环境 ID（EnvId）**，例如 `summer-pet-family-1g2h3j4k5l`；
2. **地域（Region）**，建议上海，对应 `ap-shanghai`；
3. **客户端 Publishable Key**。

Publishable Key 是浏览器端公开凭证，不是 SecretId/SecretKey。官方说明它以匿名角色
访问，并且设计为可安全暴露在客户端代码中：
<https://docs.cloudbase.net/api-reference/webv2/api-key>。

不要提供或提交以下内容：腾讯云登录密码、短信验证码、SecretId、SecretKey、服务端
API Key、银行卡或付款信息。

## 1. 创建 CloudBase 环境

1. 登录 CloudBase 控制台，创建环境，名称建议 `summer-pet-family`。
2. 选择**文档数据库**，不要选择 PostgreSQL。本云函数使用 CloudBase Document
   Database API。
3. 地域建议选择上海 `ap-shanghai`；应用配置中的地域必须与环境一致。
4. 套餐可先选免费环境。套餐与配额可能调整，以控制台当日显示为准。

环境创建说明：<https://docs.cloudbase.net/quick-start/create-env>。

## 2. 启用匿名登录并创建 Publishable Key

1. 在环境的「身份认证 / 登录方式」中启用**匿名登录**。
2. 在「设置 / API Key 管理」创建一个 **Publishable Key**。
3. 在「环境配置 / 安全来源 / 安全域名」添加 `superbohin.github.io`。只填域名，
   **不要**带 `https://` 或路径；本地 `localhost` 默认允许。保存后等待约 1～2 分钟
   再测试。安全来源官方说明：<https://docs.cloudbase.net/envconfig/security/intro>。
4. 保存 EnvId、Region、Publishable Key；不要创建或复制服务端密钥给 PWA。

匿名登录为每个浏览器安装生成 CloudBase 用户身份，但它不是家庭设备授权。真正的设备
授权仍由本应用的 P-256 设备密钥、根签名配置和角色白名单完成。
家庭口令用于端到端加密，首次创建要求至少 10 个字符；不要使用孩子姓名、生日或简单
数字组合。
设备申请还会携带由家庭 AES 密钥进行用途隔离后生成的 HMAC 证明；CloudBase 只保存
该申请授权密钥，无法据此解密家庭正文。没有家庭口令的外部匿名访问者不能伪造或挤占
审批队列。

## 3. 创建三个文档数据库集合

在「文档数据库 / 集合管理」中创建：

- `summer_pet_config`
- `summer_pet_events`
- `summer_pet_device_requests`

在 `summer_pet_events` 的「索引管理」新增组合索引：`timestamp` 升序、`_id`
升序。云函数用这两个字段稳定分页；CloudBase 的索引入口与组合索引说明见
<https://docs.cloudbase.net/database/data-index>。

对三个集合分别进入「权限管理 / 安全规则」，粘贴
[`cloudbase/rules/database-deny-all.json`](../cloudbase/rules/database-deny-all.json)：

```json
{
  "read": false,
  "write": false
}
```

这会禁止浏览器直接访问数据库，但云函数和控制台管理员仍可访问。不要把集合改成
「所有人可读」或「所有人可写」。CloudBase 官方的管理员专用规则也是客户端读写均为
`false`：<https://docs.cloudbase.net/en/rule/rule-example>。

## 4. 部署 `summer-pet-family` 云函数

云函数源代码在
[`cloudbase/functions/summer-pet-family`](../cloudbase/functions/summer-pet-family)。
它是普通事件云函数，不是 HTTP 云函数，运行时使用 Node.js 20。

### 命令行部署

```bash
npm install -g @cloudbase/cli
tcb login
cp cloudbaserc.example.json cloudbaserc.json
```

把 `cloudbaserc.json` 第一行的占位 EnvId 改成真实 EnvId。该文件包含环境标识，不必
提交到公开仓库。然后执行：

```bash
npm --prefix cloudbase/functions/summer-pet-family install --omit=dev
tcb fn deploy summer-pet-family --force --yes
```

CLI 官方部署命令说明：
<https://docs.cloudbase.net/cli-v1/functions/deploy>。也可以在控制台新建同名普通云函数，
上传函数目录并选择「保存并安装依赖」。

### 云函数调用权限

在「云函数 / 权限控制」使用
[`cloudbase/rules/function-authenticated.json`](../cloudbase/rules/function-authenticated.json)：

```json
{
  "*": { "invoke": false },
  "summer-pet-family": { "invoke": "auth != null" }
}
```

这样只有已经登录（包括匿名登录）的客户端能调用此函数，其他函数默认禁止客户端
调用。函数权限规则是环境级配置；如果该环境还有别的函数，合并现有规则后再保存，
不要直接覆盖。官方规则语法：
<https://docs.cloudbase.net/en/cloud-function/security-rules>。

## 5. 配置 PWA 构建

复制仓库中的 `.env.example` 为本机 `.env.local`：

```bash
cp .env.example .env.local
```

填写：

```dotenv
VITE_CLOUDBASE_ENV_ID=你的真实EnvId
VITE_CLOUDBASE_REGION=ap-shanghai
VITE_CLOUDBASE_PUBLISHABLE_KEY=你的PublishableKey
VITE_CLOUDBASE_FUNCTION_NAME=summer-pet-family
```

GitHub Pages 的生产构建需要把前三个值设为应用仓库的 **Settings → Secrets and
variables → Actions → Variables（Repository variables）**，再由构建工作流注入
`VITE_*`。这里不使用 Actions Secrets：Publishable Key 最终会出现在前端产物中，
这是它的用途；SecretId/SecretKey 不能以任何 `VITE_*` 名称注入。

部署后先在 CloudBase 控制台测试函数：

```json
{ "action": "health" }
```

应返回 `ok: true`。**先在家长设备初始化或迁移家庭配置，再公开发布带 Publishable
Key 的 Pages 版本**，避免空环境的首次初始化入口被他人抢占。之后再让孩子 iPad
连接；孩子设备会自动提交申请，家长批准后才有权写入同步事件。

## 云函数接口与安全约束

所有成功响应统一为 `{ "ok": true, "data": ... }`，支持以下 `action`：

- `health`
- `getConfig`
- `initializeConfig`
- `updateConfig`（必须携带 `expectedRevision`，并发冲突时拒绝覆盖）
- `submitDeviceRequest`
- `listDeviceRequests`
- `resolveDeviceRequest`
- `listEvents`（可携带 `excludeIds`）
- `appendEvent`

`initializeConfig` 和 `updateConfig` 会验证根设备 ECDSA 签名；`appendEvent` 会重新读取
当前签名配置，并在数据库事务内校验设备、角色、操作白名单及事件签名。同一事件 ID
重复提交且内容完全一致时按成功处理，内容不同则拒绝。

新事件时间最多允许比云函数服务器时间快 5 分钟。若管理员直接改库，或后续角色/撤销
变更使某条旧记录无法按最新配置重放，`listEvents` 会隔离该条异常记录，不会让所有家庭
设备的全量同步永久失败。

`resolveDeviceRequest` 只允许清理已经出现在当前根签名配置中的设备申请。匿名调用者
无法删除尚未批准的申请；家长拒绝某个未批准申请时，客户端忽略它即可。若以后需要
物理删除被拒申请，应新增根设备签名的拒绝凭证，不能仅凭客户端传入 deviceId 删除。

## 数据保留与迁移

- 升级或切换同步提供方不会删除 IndexedDB；本机历史数据仍是权威副本。
- 迁移前在旧家长端导出一次 JSON 备份。
- 根家长设备点击“迁移到 CloudBase”后，应用会读取本机 IndexedDB 的完整记录、验证
  当前签名配置，并向 CloudBase 写入一条包含打卡、金币、兑换和流水完整历史的累积
  `state.snapshot`。只有回读确认该快照完全一致后，才把本机同步通道切为 CloudBase；
  失败时仍保留 GitHub profile。其他家长设备和孩子 iPad 随后各点击一次迁移。
- 旧 GitHub 加密事件不会删除，继续作为迁移前的审计备份；CloudBase 从上述完整快照
  继续记录新事件。
- 原 GitHub 私有数据仓库先保留为只读加密备份，不要立即删除。
- 清除 Safari 网站数据会删除 IndexedDB 和不可导出的设备私钥；该 iPad 会成为新设备，
  必须重新申请家长批准。因此 JSON 导出备份和至少一台保留根设备私钥的家长设备都很
  重要。

## 上线验收

1. 三个数据库集合均为客户端读写 `false`。
2. 匿名登录已启用，未登录调用云函数被拒绝。
3. `health`、家长初始化、孩子申请、家长批准均成功。
4. 孩子提交打卡后，家长自动拉取；家长审批后，孩子自动拉取。
5. 连续同步最多只保留一个活动累积快照；重复提交同一事件不重复结算。
6. iPad 离线打卡后重新联网，历史、余额、兑换记录和本地数据都不丢失。
7. 在另一浏览器直接使用 Web SDK 访问三个集合应返回权限拒绝。
8. 保留迁移前 JSON 和原 GitHub 加密仓库，直到至少完成一周双设备验收。
