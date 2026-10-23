# GitHub 打包与 Chrome 商店发布

## 正式变更流程

公开源码通过 GitHub 正式 PR 维护：从分支提交改动，创建 PR，等待已配置的 CI 和自动代码 / 安全审阅按其触发条件运行；查看并处理审阅意见，再合并 PR。合并后，从 `main` 手动运行 GitHub Actions 生成用于商店的正式包，并按需要查询商店、上传草稿或提交审核。CI 和 AI 审阅是检查与反馈，不代表商店已更新。

最终商店包以合并到 `main` 的源码及 GitHub Actions 产物为准。本地 ZIP 只用于开发预览；PR CI 的 ZIP 可用于合并前检查，不作为最终商店发布包。

发布入口：仓库 **Actions → Build and publish Chrome Web Store extension → Run workflow**。工作流只响应手动操作，不在推送代码或 PR 时自动发布。请在 `main` 上运行。

| operation | 效果 |
| --- | --- |
| `build`（默认） | 构建、运行离线测试和既有公开文件检查，生成可下载的扩展 ZIP；不连接 Google |
| `status` | 使用 Google 短期访问令牌查询现有商店条目；不打包、不上传、不提交审核 |
| `upload` | 构建 ZIP，上传为现有商店条目的新草稿，等待 Google 确认上传完成；不提交审核 |
| `publish` | 构建、上传成功后提交正常审核；审核通过后按现有可见性设置自动发布 |

`github_release` 默认关闭。打开时，成功构建（以及所选商店操作成功）后创建 `v<manifest.version>` GitHub Release，并附上同一 ZIP。`status` 忽略此选项。已存在同名 Release 时 GitHub 会返回错误，不自动覆盖已有发行版。

## 包含什么

ZIP 仅包含 `scripts/package-extension.mjs` 列出的 24 个公开运行文件，`manifest.json` 位于 ZIP 根。源码、测试、合成演示、商店素材、凭据、本机调试文件和个人数据目录都不进入扩展 ZIP。工作流产物保留 14 天；GitHub Release 的附件长期保留。

现有 push / PR 离线检查成功后也会生成 `boss-chat-recorder-ci` ZIP 产物，便于在合并前下载检查；该 CI 流程不申请 Google 令牌、不访问商店。

本地打包也可使用 Node.js 24，无需安装依赖：

```sh
npm run build
npm test
npm run check
npm run package:extension -- --output /path/to/extension.zip
```

省略 `--output` 时写入被 Git 忽略的 `dist/boss-chat-recorder-<version>.zip`。请先运行源码检查再打包；扩展 ZIP 本身不进入源码文件清单。

## 一次性 Google 认证

商店更新使用 [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api) 和[发布服务账号](https://developer.chrome.com/docs/webstore/service-accounts)。固定目标扩展 ID 为 `phaihpchfdihnclgjhpmpnhobdcogdhb`。

采用 GitHub OIDC → Google Workload Identity Federation → 发布服务账号 → 短期 OAuth access token。无需在仓库保存服务账号 JSON 私钥、个人 refresh token 或浏览器 Cookie。Google 官方认证组件仅在执行商店任务时生成访问令牌，不生成可进入构建产物的凭据文件。

`status` 仅申请 Google 官方的 `chromewebstore.readonly` 作用域；`upload` 和 `publish` 才申请 `chromewebstore` 写入作用域。

配置步骤：

1. 在自己的 Google Cloud 项目启用 `chromewebstore.googleapis.com`、`iam.googleapis.com`、`iamcredentials.googleapis.com` 和 `sts.googleapis.com`。
2. 创建专用发布服务账号，不授予它项目 Owner / Editor 等宽泛角色。
3. 创建 GitHub Workload Identity Pool / OIDC Provider，issuer 为 `https://token.actions.githubusercontent.com`。信任限定到本仓库及 `refs/heads/main`，使用 GitHub 的数字仓库和所有者 ID；不要信任任意 GitHub 仓库。
4. 在该服务账号上授予对应 GitHub 身份 `roles/iam.workloadIdentityUser`，允许工作流代表该服务账号申请短期令牌。
5. 在 Chrome 商店开发者后台左侧 **PUBLISHER → Settings** 中向下滚动，找到 **Service account**，填入该服务账号邮箱，点击 **Add a service account**。该字段不在 **ACCOUNT → Profile** 页。Google 当前每个发布者只支持绑定一个服务账号；已有绑定时先确认其用途。
6. 从商店后台 **Publisher → Settings** 获取 Publisher ID。
7. 在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 设置以下三个变量。这些是资源标识，不是私钥；不要把令牌写进变量。

| GitHub Variable | 值 |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `CWS_SERVICE_ACCOUNT` | 专用发布服务账号邮箱 |
| `CWS_PUBLISHER_ID` | 商店后台显示的 Publisher ID |

Google 配置方法见 [部署流水线身份联合](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)；工作流使用的认证输入见 [google-github-actions/auth](https://github.com/google-github-actions/auth)。首次登录、接受 Google 条款以及最终发布权限绑定需由账号所有者确认。此流程不要求开通付费计算资源。

## 首次验证与日常更新

首次先运行 `build`，确认 Actions 成功并可下载 ZIP；配置 Google 身份后运行 `status`，确认能查询到目标扩展的线上版本和审核状态。只执行这两个操作不会更改商店内容。

日常更新时修改公开源码，同时递增 `package.json` 与 `extension-tracker/manifest.json` 的版本，经过 PR 检查和审阅后合并到 `main`，再手动运行发布工作流。需要先把包上传为草稿并检查时选择 `upload`；确认可以送审后选择 `publish`。`publish` 会重新构建、上传并提交审核。Google 不接受重复版本号；工作流不会自动修改或提交版本号。开发调试版的版本不要求与商店同步。

如果暂不提交审核，选择 `build`、`status` 或 `upload`，不要选择 `publish`。

API 返回“已提交审核”不代表已经公开。审核结果、账号问题及商店文案或隐私披露的修改仍以开发者后台为准；本工作流不会改动商店文案、图片、可见性或账号设置，也不会申请跳过审核。

同一扩展的上传与提交共用 GitHub 并发组，避免两次手动发布交错上传不同草稿；状态查询不占用该组。`publish` 会构建并上传本次代码，不是仅提交先前草稿；重复上传相同版本若被 Google 拒绝，任务会结束，不会继续提交其它草稿。

## 命令行接口

发布客户端从环境变量读取 `CWS_PUBLISHER_ID`、`CWS_EXTENSION_ID`、`CWS_ACCESS_TOKEN`。令牌仅用于固定 Google 官方 API，不输出到日志。可用命令：

```sh
npm run store:status
npm run store:upload -- --zip /path/to/extension.zip
npm run store:publish
```

`upload` 与 `publish` 是实际写操作；连接验证只使用 `status`。上传异步处理时仅轮询 Google 状态接口，不重新上传；上传失败或等待超时会使任务失败，随后不会提交审核。
