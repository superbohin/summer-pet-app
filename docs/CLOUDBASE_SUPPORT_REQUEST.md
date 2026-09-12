# 腾讯云协助排查：PG 环境匿名会话调用函数被拒

## 请求协助

请核查下述 PostgreSQL 环境中 HTTP API 云函数调用的鉴权链路：真实匿名登录已成功，
目标函数的 OPA 用户策略明确允许该会话，但健康接口仍返回 `403 EXCEED_AUTHORITY`。
我们不希望开放未登录调用、公开管理员 Key，或解除家庭数据权限来规避问题。

## 环境与最小复现

- 验证日期：2026-09-12。
- EnvId：`pet-d8gvpbx0b32ce11a3`，地域 `ap-shanghai`，PostgreSQL。
- 事件云函数：`summer-pet-family`，Nodejs20.19。
- 请求：`POST https://pet-d8gvpbx0b32ce11a3.api.tcloudbasegateway.com/v1/functions/summer-pet-family`
- 请求体：`{"action":"health"}`，不读写家庭业务记录。
- 登录：客户端 Publishable Key 初始化 SDK，再 `signInAnonymously()` 取得真实用户
  access token；请求使用真实 token，不以 Publishable Key 冒充登录会话。
- token 内容仅核对类型：`role=anon`、`client_type=client_user`，主体非空且不是 `anon`。
  出于安全考虑，本文件不包含 Key、token、用户 ID 或签名材料。

## 已验证结果

| 检查 | 结果 | 请求 ID |
| --- | --- | --- |
| 真实匿名会话，无 Origin | 403，EXCEED_AUTHORITY | 8048a83c-0987-4a90-b7aa-6cabe1efa702 |
| 同会话，已允许的腾讯静态来源 | 403，同码，响应正确包含该来源的 CORS 许可 | d8682ed9-a4b7-496a-9388-ef1fb0a60ba0 |
| 同会话，GitHub Pages 来源 | 403 空响应，无 CORS 许可 | fa810bd9-fee5-4d53-af88-90ca18076a03 |
| 临时更严格的路径级诊断 deny 下，真实会话 | 403，EXCEED_AUTHORITY，未出现诊断标识 | 9da6b34c-7aed-4947-9e35-53d1afdb6274 |

第三项的来源域名未添加成功，平台 `CreateAuthDomain` 明确报“当前套餐无法执行此操作”。
但第二项已经具有正确来源许可，说明同一函数的调用失败不能仅归因于 GitHub 来源缺失。

- 环境元数据 `authz_engine=opa`；`authz.platform.extension.rego` 为空。
- `authz.user.rego` 回读匹配本项目 `cloudbase/rules/pg-function-policy.rego`。
- 策略精确限定 `tcbopenapi` / `functions` / `/v1/functions/summer-pet-family`，允许
  POST 的真实用户会话；明确拒绝无登录及仅公开 Key 的访问。
- 无凭据及仅公开 Key 的负测均未调用成功。
- 临时诊断只增加更严格的固定路径 POST deny，不扩大权限；检查结束已恢复原策略并回读确认。
  多条 deny 的返回方式、缓存及请求阶段仍需平台核查，不能仅据标识缺失断言 OPA 被绕过。
- 查询旧 `DescribeResourcePermission` API 被平台拒绝，说明 PG 环境不支持该 API；
  没有尝试通过全环境放开或切换旧鉴权来规避。
- 管理端云 API 能成功调用该函数的健康接口；另已验证函数现有运行角色可通过
  `ExecutePGSql`，显式以 `service_role` 执行固定只读权限查询。数据库权限与入口错误分开处理。
- 服务端已经改用该运行身份路径，真实 `getConfig` 正确返回家庭未初始化，不再出现数据库
  权限错误；入口 403 仍可复现。所有临时函数诊断入口已删除并验证不可调用。

## 请平台确认

1. PG 环境的 `/v1/functions/:name` 是否仍经过独立的函数安全规则？如是，应使用哪个
   当前支持的控制台入口或 API 修改单个函数的登录用户调用权限？
2. 真实匿名会话到达哪一层时产生 `EXCEED_AUTHORITY`？该层是否读取了当前 OPA 用户策略？
3. 为什么针对同一路径 POST 的诊断 deny 没有出现在真实会话拒绝信息中？
4. 已允许来源的请求被拒与套餐是否相关？请区分来源设置限制与函数调用权限限制。

参考官方说明：

- [HTTP API 云函数调用](https://docs.cloudbase.net/http-api/functions/functions-post)
- [OPA 用户策略与优先级](https://docs.cloudbase.net/envconfig/authz-opa/intro)
- [云函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)

此文件可直接提交腾讯云工单；不要额外附上 `.env.local`、CLI 登录凭据、浏览器会话或家庭数据。
