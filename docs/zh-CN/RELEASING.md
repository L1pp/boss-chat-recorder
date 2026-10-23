# 打包与 Chrome 商店发布

[English](../RELEASING.md) | [简体中文](RELEASING.md)

## 手动发布工作流

公开变更经过聚焦的分支与 PR、已配置的 CI/审阅，合并到 `main` 后再发布。正式商店包来自 GitHub Actions 对已合并 `main` 的构建，本地和 PR CI ZIP 用于预览；多个 PR 可以组成一个版本。

打开 **Actions → Build and publish Chrome Web Store extension → Run workflow**，选择 `main`。[工作流](../../.github/workflows/release.yml) 仅响应手动触发。

| `operation` | 效果 |
| --- | --- |
| `build`（默认） | 构建、运行离线/浏览器测试与公开检查并生成 ZIP，不连接 Google；也可用 `build_run_id` 选择已有测试包 |
| `status` | 使用短期令牌读取现有商店条目状态，不构建、不上传、不提交 |
| `upload` | 上传所选 ZIP 为草稿，等待 Google 确认，不提交审核 |
| `publish` | 上传所选 ZIP 并提交正常审核，通过后按条目现有可见性发布 |

`build_run_id` 可留空，表示本轮构建和测试一次；填入原始成功 `main` 发布构建的 run ID，则下载该轮保留的 `boss-chat-recorder-<version>` 产物，跳过打包 job、依赖安装和测试，直接使用原 ZIP，不重新生成或修改它。PR CI 预览、失败轮次和已过期产物不能作为正式发布来源。`status` 忽略此输入。复用模式的 `build` 是来源选择预览，不新建 Actions 产物；该轮摘要会给出原始 ZIP 所在轮次的链接。需要上传或创建 GitHub Release 时，对应 job 才下载同一原始产物。

分阶段发布时：

1. 在 `main` 运行 `build`，可同时开启 `github_release=true`，记下该轮 run ID。
2. 运行 `upload`，填入该 `build_run_id`；然后在商店后台修改并保存文案等资料。
3. 运行 `publish`，填入同一 ID。它会先上传同一份已测试 ZIP 再送审，避免提交其他草稿。

一次完成的更新仍可用空 ID 运行 `publish`：仅构建一次，随后上传和送审。商店写入和 GitHub Release 创建只在 `main` 执行，分支构建仅用于预览。

`github_release` 默认为 `false`。启用后，构建及所选商店操作成功才创建附同一 ZIP 的 `v<所选版本>` GitHub Release，新标签使用原始构建提交，而非后来触发发布流程的提交；已有标签保留其指向。`status` 忽略此选项，同名 Release 已存在时失败，不覆盖。CI 及 `github_release=false` 的 `build` 不创建 GitHub Release，也不向商店送审。

首次配置先用 `build` 检查包，再在 Google 身份配置后用 `status` 检查连接。日常更新修改公开源码及 `package.json`、`extension-tracker/manifest.json` 版本字段，完成 PR 并合并后再触发。已授权更新草稿时选 `upload`，已授权送审时选 `publish`。已发布版本更新时须递增版本字段，工作流不自动递增或提交版本；独立开发版无需与商店同步。

上传和提交共用扩展专属并发组，状态查询不占用该组。Actions 的 `publish` 上传所选已测试 ZIP，上传失败时不会继续提交其他草稿。

提交确认不等于已经公开。审核结果、商店文案、图片、隐私披露、可见性和账号设置仍由商店后台管理，工作流不修改这些内容或跳过审核。

## 包内容与本地预览

ZIP 仅包含 `scripts/package-extension.mjs` 明确列出的运行文件，`manifest.json` 位于根目录；不含纯源码模块、测试、演示、商店素材、凭据、调试文件或个人数据。

Actions ZIP 保留 14 天，过期后需重新构建和测试。`main` 推送/PR 检查另生成 `boss-chat-recorder-Linux-ci`、`boss-chat-recorder-Windows-ci` 预览，不申请 Google 令牌；GitHub Release 附件随该 Release 保留。

本地预览先完成[测试指南](TESTING.md)中的构建与检查，再运行：

```sh
npm run package:extension -- --output /path/to/extension.zip
```

省略 `--output` 时写入被忽略的 `dist/boss-chat-recorder-<version>.zip`。打包使用 Node.js 24，无需安装依赖。

## 一次性 Google 身份配置

目标扩展为 `phaihpchfdihnclgjhpmpnhobdcogdhb`，商店操作使用 [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api) 和[发布服务账号](https://developer.chrome.com/docs/webstore/service-accounts)。

认证链路为 GitHub OIDC → Google Workload Identity Federation → 发布服务账号 → 短期 OAuth 令牌。仓库不保存服务账号私钥、个人 refresh token 或浏览器 Cookie；认证组件不生成打包凭据文件。`status` 申请 `chromewebstore.readonly`，仅 `upload`/`publish` 申请 `chromewebstore` 写入作用域。

1. 在所有者 Google Cloud 项目启用 `chromewebstore.googleapis.com`、`iam.googleapis.com`、`iamcredentials.googleapis.com` 和 `sts.googleapis.com`。
2. 创建专用发布服务账号，不授予宽泛的 Owner/Editor 角色。
3. 创建 Workload Identity Pool/OIDC Provider，issuer 为 `https://token.actions.githubusercontent.com`；用 GitHub 数字仓库和所有者 ID，将信任限定到本仓库及 `refs/heads/main`。
4. 在服务账号上授予对应 GitHub 身份 `roles/iam.workloadIdentityUser`。
5. 商店后台使用 **PUBLISHER → Settings → Service account → Add a service account** 绑定其邮箱，该入口独立于 **ACCOUNT → Profile**。每个发布者支持一个绑定，替换前检查已有绑定用途。
6. 从 **Publisher → Settings** 获取 Publisher ID，在仓库 **Settings → Secrets and variables → Actions → Variables** 设置：

| 变量 | 值 |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `CWS_SERVICE_ACCOUNT` | 发布服务账号邮箱 |
| `CWS_PUBLISHER_ID` | 商店 Publisher ID |

这些变量只存标识，不存令牌或私钥。首次登录、Google 条款和发布者关联由账号所有者完成。

配置参考：[部署流水线身份联合](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)、[google-github-actions/auth](https://github.com/google-github-actions/auth)。

## 发布客户端 CLI

客户端从环境读取 `CWS_PUBLISHER_ID`、`CWS_EXTENSION_ID` 和 `CWS_ACCESS_TOKEN`。令牌仅用于固定 Google 官方 API，不写入日志。

```sh
npm run store:status
npm run store:upload -- --zip /path/to/extension.zip
npm run store:publish
```

CLI 分别提供状态、上传和提交步骤。连接检查使用 `status`；`upload` 和 `publish` 会修改商店。异步上传只轮询状态、不重新上传；错误或超时会使操作失败，工作流不会继续送审。
