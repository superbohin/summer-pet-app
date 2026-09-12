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
2. 控制台如果只提供 PostgreSQL，直接使用该环境。本项目支持 PostgreSQL 存储层，
   无需重建环境。通用文档提到部分 PG 环境可并存文档库，但应以实际 API 能力为准：
   `DescribeTables` 若返回没有文档数据库实例，不要继续执行文档库建集合命令。
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

## 3. 创建家庭数据存储

### PostgreSQL 环境（本次实际采用）

先读取 `public` 已有表，确认不存在同名但结构不同的表，再执行
[`cloudbase/sql/001-family-sync.sql`](../cloudbase/sql/001-family-sync.sql)。该迁移仅建立
本应用的三张表、索引和专用 RPC，不删除或导入家庭数据。

- `summer_pet_config`
- `summer_pet_events`
- `summer_pet_device_requests`

三张表均启用 RLS，客户端不能直接读写。RPC 也检查服务端身份，不能只依赖
`GRANT EXECUTE`；官方说明 HTTP RPC 网关不强制检查 EXECUTE 权限：
<https://docs.cloudbase.net/database/postgresql/rpc>。

在云函数环境变量中设置 `SUMMER_PET_STORAGE=postgresql`。浏览器不得获得数据库
密码或服务端 API Key。**不能只因云函数部署成功，就假定运行时管理凭证能访问 PG。**
必须真实调用 `getConfig` 验证；若管理凭证缺少 PG 的 `role`，可能返回
`DATABASE_42501` / `function-permission`。此时应为云函数配置服务端 `service_role`
凭证，不能给 `anon` / `authenticated` 放开家庭表或函数权限来绕过错误。

在控制台「API Key 管理」创建 **API Key（service_role，服务端）**，只在
`summer-pet-family` 云函数环境变量中设置 `CLOUDBASE_APIKEY`。不要使用
Publishable Key 替代，不要把值发到聊天、提交仓库或配置为 `VITE_*`。
SDK 在 Node 环境自动识别该变量；当前函数固定使用 3.8.2。配置后再真实检查数据库。

**后续更新的重要限制：** CLI 3.8.1 的 `fn deploy --force` 默认覆盖环境变量，可能
删除只在控制台配置的 Key！配置该变量之后，普通代码发布应使用仅更新代码的
`tcb fn code update`（先查看该版本 `--help`）；如必须更新完整配置，需安全读取并合并
保留既有云端环境变量，不能把密钥写入命令行或日志。不能直接重复上面的全量部署。

应用仍验证原有设备签名和家庭权限。事务回调先在云函数内完成验证，SQL 提交时持有
家庭专用事务锁，复核读集后一次提交全部写入；若配置或记录并发变化，重新读取并验证。
因此设备撤销、配置更新和事件追加不会因为改用 PostgreSQL 而失去原子性。

### 已有可用文档数据库的传统环境

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
tcb fn deploy summer-pet-family --force --install-dependency true
```

以上全量部署命令仅用于首次部署或已确保保留所有云端环境变量的配置。已在控制台
设置 `CLOUDBASE_APIKEY` 后，遵循前述“仅更新代码”的限制，避免更新时删除密钥。

CLI 官方部署命令说明：
<https://docs.cloudbase.net/cli-v1/functions/deploy>。也可以在控制台新建同名普通云函数，
上传函数目录并选择「保存并安装依赖」。

### 云函数调用权限

PG 环境先执行 `tcb policy get --json` 与 `tcb policy get --extension --json`，读取现有
OPA 用户策略和扩展策略。旧 `ModifyResourcePermission` / 函数权限 JSON 不能直接套用
到 PG 环境。只合并针对 `summer-pet-family` 的规则，保留其它资源策略。

OPA 的平台默认策略可能允许匿名及未登录访问，`default allow := false` 不代表最终
默认拒绝。应显式拒绝该函数的未登录调用，并实测“仅 Publishable Key 被拒、真实匿名
登录会话允许”。匿名会话的角色仍可能为 `anon`，不能只按角色名全部拒绝；还需核对真实
用户标识。配置参考：<https://docs.cloudbase.net/envconfig/authz-opa/intro>。

针对空白用户策略的模板在
[`cloudbase/rules/pg-function-policy.rego`](../cloudbase/rules/pg-function-policy.rego)。
有既有策略时只合并其中 `summer_pet_*` 规则，不能直接替换。策略中的用户标识映射
需要真实环境正反向测试，不能仅凭保存成功就认定登录限制有效。
模板只显式允许目标函数的真实用户会话 POST；已登录仍出现平台权限错误时，不能
进一步放开公开 Key 或无登录访问作为修复。可用 `scripts/check-cloudbase-access.mjs`
验证正常路径及编码、旧入口负测；正向健康调用也必须成功。
注意：CLI 保存 OPA 用户策略会停用旧版网关鉴权；即使新规则只匹配单个函数，也应先
确认该环境是否存在依赖旧版鉴权的其它入口，并由环境所有者批准后再保存。

传统环境的权限配置如下（仅用于支持该接口的环境）：

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

应返回 `ok: true`。然后执行 `npm run check:cloudbase`：它会使用本机 `.env.local`
完成真实匿名登录，检查函数和数据库连接；不会创建家庭、打卡或兑换记录。仅 `health`
成功不能证明数据库可用，必须继续检查 `getConfig` 成功或明确返回未初始化。

从旧 GitHub 家庭迁移时，先验证原 `config/household.json` 的签名，将其中的
`rootDeviceId` 配置为云函数环境变量 `SUMMER_PET_ROOT_DEVICE_ID`。这样首次初始化
只接受原根家长签名的配置，避免发布后空环境被另一个家庭抢占。该标识不含私钥。

如果是全新家庭、尚无可信根设备标识，则仍须先私下初始化，再公开发布客户端配置。
之后孩子设备自动提交申请，家长批准后才有权写入同步事件。

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

1. PostgreSQL 三张表和 RPC 均拒绝客户端直接访问；传统文档库的三个集合读写均为 `false`。
2. 匿名登录已启用，未登录调用云函数被拒绝。
3. `health`、家长初始化、孩子申请、家长批准均成功。
4. 孩子提交打卡后，家长自动拉取；家长审批后，孩子自动拉取。
5. 连续同步最多只保留一个活动累积快照；重复提交同一事件不重复结算。
6. iPad 离线打卡后重新联网，历史、余额、兑换记录和本地数据都不丢失。
7. 在另一浏览器直接使用 Web SDK 访问三张表/三个集合及内部 RPC，应返回权限拒绝。
8. 保留迁移前 JSON 和原 GitHub 加密仓库，直到至少完成一周双设备验收。
