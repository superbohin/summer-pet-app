# 我的暑假小伙伴

适合小学二年级孩子在 iPad 上使用的暑假打卡养宠物 PWA。

## 功能

- 每日任务打卡、金币和经验奖励
- 宠物选择、升级、喂食、洗澡、玩耍和换装
- 统一角色图鉴：4 只宠物原形、4 位二次元少年伙伴和 4 个家庭私用蛋仔角色
- 阅读、练字、暑假作业等重点任务必须填写完成范围；其他任务可以一键提交
- 家长每天只需验证一次密码，默认全选后批量验收，漏审日期也能日后补处理
- 每日喂食记录和可配置的漏喂惩罚（不重复扣罚、金币不会为负）
- 图片化虚拟金币商店，以及可编辑、可追踪兑现状态的现实奖励
- 现实奖励兑换立即预扣金币；家长可标记已兑现，或拒绝并按兑换原价退款
- 成长月历、连续打卡和成长徽章
- 家长任务管理、数据备份、恢复和打印
- 版本化数据迁移、收支流水和更新前安全快照
- GitHub Pages 孩子端 `#/child` 与家长端 `#/parent`
- 指定设备密钥授权、私有 GitHub 仓库加密同步和离线事件队列
- 数据优先保存在当前设备，首次打开后支持离线使用

## 更新、离线与历史数据

程序、设备本地数据和家庭同步数据分为三层：

- GitHub Pages 发布界面；Service Worker 联网获取新程序。
- iPad 上的打卡、金币、经验、兑换和设置保存在当前网址对应的 IndexedDB。
- 私有家庭数据仓库保存根签名配置和加密、签名、只追加的事件；GitHub Actions 负责验证事件后写入，不需要自建服务器。
- 新版本第一次读取旧数据时，按数据结构版本顺序迁移；迁移前先保存旧数据快照。
- 迁移失败时进入“记录保护模式”，不会用空白数据覆盖旧记录。
- 多设备合并按角色限制字段并按事件 ID 去重；孩子快照不能自行发奖励、伪造验收或覆盖家长规则。

因此，在**始终使用同一个 HTTPS 网址**的前提下，发布新版不会删除历史数据。GitHub 本身不是运行地址：代码推送到 GitHub 后，还需要部署到原来的生产网址，iPad 才能收到新版功能。

> 私有仓库同步是第二份加密历史，但仍建议每周从家长端导出 JSON。清除 Safari 网站数据会删除本机设备私钥，该设备需要重新申请批准。

> 从现有 Sites 地址第一次迁到 GitHub Pages 时，网址来源发生变化，Safari 不能自动读取旧来源的 IndexedDB。必须先在旧站导出 JSON，再在新 GitHub Pages 家长端恢复一次；之后固定使用同一个 Pages 地址，正常版本更新会保留历史。

## 本地运行

```bash
npm install
npm run dev
```

电脑浏览器访问 `http://localhost:3000`。

## 在 iPad 上试用

开发调试时，让电脑与 iPad 连接同一 Wi-Fi，并用 `npm run dev -- --host 0.0.0.0` 启动。然后在 iPad Safari 中打开电脑的局域网地址。

正式使用建议部署到 HTTPS 地址。Safari 首次成功打开后，点击“分享”→“添加到主屏幕”。之后可从桌面图标启动；断网时仍能打卡，联网后再同步。

## GitHub Pages 与私有家庭仓库

推荐使用两个仓库：

1. 应用仓库：保存本项目并通过 `.github/workflows/pages.yml` 发布 GitHub Pages。页面本身和图片会公开访问。
2. 家庭数据仓库：必须设为 Private。把以下三个文件按原路径复制进去：
   - `.github/workflows/family-sync.yml`
   - `scripts/github-family-sync-action.mjs`
   - `lib/github-family-sync.ts`

发布后分别使用：

- 孩子端：`https://<用户名>.github.io/<仓库名>/#/child`
- 家长端：`https://<用户名>.github.io/<仓库名>/#/parent`

每台 iPad 都先打开自己的角色地址，再“添加到主屏幕”。

在 GitHub Pages 的孩子端或家长端首次配置时，填写私有数据仓库、家庭口令和对应设备的 fine-grained PAT。Token 只存于该浏览器的 IndexedDB，不写入仓库、网址或设备申请 JSON。

- 根家长设备：Contents 读写、Actions 读写。
- 孩子设备：Contents 只读、Actions 读写。
- 新设备生成 non-extractable P-256 私钥和申请 JSON，由根家长设备批准。
- 普通网页不能读取 iPad 硬件序列号；“指定设备”实际依赖该设备持有已批准的不可导出私钥。

完整安全边界与配置步骤见 [GitHub 家庭同步说明](docs/GITHUB_SYNC.md)。

## GitHub 与发布

仓库已包含持续集成、Pages 发布和家庭同步三个 GitHub Actions 工作流。

推荐发布步骤：

1. 修改代码；如需改变数据结构，先按 [升级规则](docs/UPGRADING.md) 添加迁移函数和测试。
2. 在 `package.json` 提升版本号。
3. 运行 `npm test`、`npm run typecheck:app`、`npm run lint` 和 `npm run build:pages`。
4. 将主分支推送到应用仓库；Pages Workflow 会验证并发布同一提交。
5. iPad 联网打开原 GitHub Pages 地址；出现“新版本已准备好”后点击安全更新。

`npm run build` 继续生成原 Vinext/Sites 版本；`npm run build:pages` 生成 `pages-dist/` 静态 PWA。Pages 构建使用相对根路径，不需要硬编码仓库名。

家庭非商用、非官方产品。《蛋仔派对》及相关角色素材权利归原权利人所有，本应用仅供家庭内部使用。GitHub Pages 上的前端图片属于公开可下载资源。

## 检查

```bash
npm run build
npm run build:pages
npm test
npm run typecheck:app
npm run lint
```
