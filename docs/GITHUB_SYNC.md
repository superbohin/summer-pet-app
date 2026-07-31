# 使用私有 GitHub 仓库进行家庭同步

这套方案不需要自建后端。每台设备的 IndexedDB 仍是本地权威数据源；GitHub 私有仓库只承担两件事：

1. 保存一份由家庭根密钥签名的配置。配置中的家庭名称等正文使用 AES-GCM 加密。
2. 保存 `events/<id>.json` 形式的签名、加密、只追加事件。

它适合家庭、小规模、允许最终一致的同步，不是通用实时数据库。

## 推荐的两个仓库

- **应用仓库**：PWA 源码和部署配置，可以是公开或私有仓库。
- **家庭数据仓库**：每个家庭单独创建一个私有仓库。放置
  `config/household.json`、`events/`、`.github/workflows/family-sync.yml`、
  `scripts/github-family-sync-action.mjs` 和校验脚本依赖的
  `lib/github-family-sync.ts`。

不要把家庭数据直接提交到应用源码仓库。若多个家庭使用该应用，每个家庭应使用不同的私有数据仓库和不同的家庭口令。

## 仓库里哪些内容可见

GitHub Action 没有家庭口令，因而不能解密家庭正文或事件负载。它必须看到以下签名后的明文元数据，才能在服务端拒绝未授权写入：

- 家庭 ID、配置版本、根公钥；
- 设备 ID、设备公钥、角色、角色有效期和撤销时间；
- 事件 ID、设备 ID、角色、操作类型和客户端时间戳。

事件的业务内容在 `ciphertext` 中，家庭配置的私密正文在
`encryptedHousehold` 中。仓库管理员、GitHub 和拿到仓库读权限的人仍可看到上述元数据、事件数量与时间。**把设备授权表也完全加密后，Action 就无法校验设备、角色和撤销状态**，两者不能同时实现。

## 浏览器端密钥

`createDeviceIdentity()` 生成 ECDSA P-256 设备密钥。私钥是
`extractable: false`，代码没有“导出私钥”接口。公钥指纹形成稳定的
`deviceId`；只要同一个 `CryptoKey` 仍在本地，设备 ID 就保持不变。

Web Crypto 的 `CryptoKey` 支持 structured clone，可直接作为 IndexedDB 记录的字段保存：

```ts
const device = await createDeviceIdentity();
await putIntoIndexedDb("device-key", device); // 保存 CryptoKey 对象本身
```

不要先转 JSON，也不要尝试把私钥导出为 JWK。清理 Safari 网站数据、无痕模式结束、恢复出厂或 IndexedDB 被系统/用户删除后，密钥可能丢失；应把该设备视为新设备，重新申请家长批准。

普通网页和 PWA 不能读取 iPad/iPhone 的硬件序列号、UDID 或 Secure Enclave 设备标识。因此本方案不能也不应把硬件序列号当设备 ID。

家庭口令通过 PBKDF2-SHA-256 和随机盐派生 non-extractable AES-256-GCM
家庭密钥。盐和迭代次数可以公开，口令和派生后的密钥不应写入 GitHub。

## 初始化与设备批准

父设备的首次流程：

1. 生成并持久化父设备密钥。
2. 创建随机 KDF 参数并从家庭口令派生家庭密钥。
3. 调用 `createInitialFamilyConfig()`。父设备成为不可撤销的根设备，配置由其私钥签名。
4. 调用 `GitHubFamilyClient.initializeConfig(token, config)` 创建
   `config/household.json`。
5. 本地固定（pin）根公钥和已接受的最高配置版本。

新设备只导出 `exportDeviceRequest()` 的设备 ID、公钥和期望角色，不导出私钥。父设备确认申请后调用
`approveOrRevokeDevice()`，再使用读取配置时得到的 SHA：

```ts
const { config, sha } = await client.readConfig(parentToken);
const next = await approveOrRevokeDevice(
  config,
  { action: "approve", request, role: "child" },
  parentDevice.privateKey,
);
await client.updateConfig(parentToken, next, sha);
```

`updateConfig` 把 SHA 发送给 GitHub Contents API；并发修改时 GitHub 返回冲突，调用方必须重新读取、重新应用更改，不能覆盖远端新版本。客户端还应拒绝根公钥变化，以及低于本地最高版本的配置，防止仓库回滚。

角色变化记录在 `roleHistory` 中。回放旧事件时使用事件发生时有效的角色；Action 接受新事件时只使用设备当前角色。撤销也类似：本地回放仍可验证撤销时间之前已经存在的历史，Action 的 append 模式拒绝被撤销设备的所有新提交，因此不能靠伪造旧时间戳绕过撤销。

## 操作权限

明文 `op` 是签名 envelope 的一部分，篡改会使 ECDSA 校验失败。

| 角色 | 允许的操作 |
| --- | --- |
| child | `state.snapshot`、`task.submit`、`reward.request` |
| parent | `state.snapshot`、`task.approve`、`task.return`、`reward.fulfill`、`reward.refund`、`task.update`、`reward.update`、`role.update`、`device.add`、`device.revoke` |

`state.snapshot` 可以承载完整的加密 `GameData`，但它不是自动获得信任的“最终状态”。Action 只能确认 envelope 的签名设备、当前角色和 `op`，无法查看密文里的字段。

接收端应按以下顺序处理：

1. 用固定的根公钥调用 `verifyConfig()`；
2. 调用 `validateEventEnvelope()` 校验设备、事件时间对应的角色、操作和签名；
3. 调用 `decryptEvent()`；
4. 把已验证的签名角色传给 reducer 或 `mergeSyncedGameData`；
5. 只合并该角色有权修改的字段和 append-only 历史。

尤其不能把 child 签名的完整快照直接覆盖本地 `GameData`。child 快照中的任务奖励、角色、设备、审批和余额等父权限字段必须忽略或重新由已验证事件计算。密文只提供保密性，不提供业务字段级授权。

## 提交和拉取事件

设备使用 `createEncryptedEvent()` 签名并加密事件，然后调用
`dispatchEvent(token, event)`。方法触发 `family-sync.yml`：

1. 校验配置的根签名；
2. 检查设备当前仍被批准；
3. 检查当前角色和 `op` allowlist；
4. 校验事件 ECDSA 签名；
5. 使用独占创建方式新增 `events/<id>.json`，绝不覆盖同名文件；
6. 提交并推送。

Workflow 使用仓库级 concurrency 串行执行，权限仅为 `contents: write`。Action 不解密负载，也不运行负载内容。

拉取时 `listEvents()` 读取 JSON 文件，按 `timestamp`、`id` 排序并去除完全相同的重复 ID；同一 ID 对应不同内容会作为冲突拒绝。当前实现使用 GitHub Contents API，单个 `events/` 目录达到 1,000 个文件时会明确停止，部署前应规划后续的签名归档或分区升级，不能静默漏读。

## 离线队列

离线时先完成本地 IndexedDB 事务，再把已经加密并签名的 envelope 放入本地 outbox。网络恢复后逐条 `workflow_dispatch`。只有 Action 成功追加并在下一次拉取中出现该 ID，才从 outbox 删除。

- 重试必须复用原事件 ID、密文和签名，不能每次生成新事件。
- `EEXIST` 需要拉取并比较同 ID 内容；不同内容是完整性冲突。
- 多设备合并应保持幂等，不能以“最后一个完整快照覆盖全部状态”代替事件归并。
- GitHub Actions 是异步的；dispatch 返回成功的 2xx 只表示请求已接收，不表示事件已提交。

## Fine-grained PAT

令牌只限制到单个家庭数据仓库，并设置有效期：

- 所有设备拉取配置和事件需要 **Contents: Read**；
- 触发 `workflow_dispatch` 需要 **Actions: Read and write**；
- 只有负责初始化或更新配置的父设备需要 **Contents: Read and write**。

权限名称和端点要求以 GitHub 官方的
[Workflow REST 文档](https://docs.github.com/en/rest/actions/workflows) 与
[Repository contents REST 文档](https://docs.github.com/en/rest/repos/contents)
为准。

child 不需要直接写 Contents。不同角色尽量使用不同令牌；不要把父设备的高权限 PAT 复制到 child 设备。客户端 API 把 token 作为每次方法调用的参数，类实例不会保存 token，也不会输出请求头或响应正文到日志。

浏览器没有真正的服务端密钥保险箱。把长期 PAT 持久化到 IndexedDB 会暴露给同源 XSS；只在内存中保留更安全但需要用户重新输入。无论采用哪种方式，都应使用严格 CSP、避免第三方脚本、缩短 PAT 有效期并支持立即撤销。

## 安全边界

- 第一次配置是信任引导。仅验证配置的自签名不能证明它属于正确家庭；必须通过父设备面对面/二维码等方式固定根公钥。
- 持有家庭口令的人能解密内容，但没有批准设备的私钥仍不能产生合法事件。
- 持有设备私钥的人能以该设备角色签名，直到撤销。私钥丢失无法恢复。
- 持有父设备根私钥的人可修改授权配置，应格外保护。
- 对数据仓库有直接写权限的人可删除或回滚事件，甚至替换整份自签名配置。客户端的根公钥固定、最高版本记录和本地权威副本只能检测部分攻击，不能替代 GitHub 审计、分支保护和仓库备份。
- `timestamp` 由客户端提供，不是可信时钟；排序只用于确定性回放，业务截止时间应由父端规则复核。
- GitHub 可观察同步元数据，且仓库可用性受 GitHub、PAT 和 Actions 配额影响。
