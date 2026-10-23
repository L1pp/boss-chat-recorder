# 测试与证据范围

[English](../TESTING.md) | [简体中文](TESTING.md)

Node 测试验证数据和控制逻辑；独立 Chromium 测试验证原生扩展 API、存储及浏览器生命周期。两层都使用仓库合成数据，不登录 BOSS、不读取个人 profile 或真实聊天、不连接商店。

## 构建与 Node 回归

使用 Node.js 24 或更新版本，本层无需安装第三方依赖：

```sh
npm run build
npm test
npm run check
npm run test:coverage
```

| 命令 | 用途 |
| --- | --- |
| `build` | 从源码生成已提交的扩展 bundle |
| `test` | 使用替代 Chrome API、DOM、IndexedDB 和 fetch 运行离线回归 |
| `check` | 比较 bundle 而不重写，检查公开文件、许可证、版本、合成示例及指定敏感模式 |
| `test:coverage` | 输出 V8 覆盖率并写入 `coverage/lcov.info` |

Node 回归覆盖增量选择、去重、分页与暂停、UID 分区和迟到写入、导出范围、提交与恢复、弹窗状态，以及发布客户端的合成 HTTP 响应。

覆盖率仅描述本次 Node 运行实际执行的 `extension-tracker/` 和 `scripts/` 文件；未加载文件可能不出现，VM/data URL 执行可能无法映射源码，Chromium 不计入。没有覆盖率百分比通过门槛。覆盖率用于定位缺失测试，源码检查也只能检测已实现的敏感模式。

生成的 `node_modules/`、报告、`coverage/` 和 `dist/` 均被忽略。运行 ZIP 使用 `scripts/package-extension.mjs` 中明确列出的文件。

## 离线演示与 fixture

直接在浏览器打开 [examples/index.html](../../examples/index.html)，无需扩展、服务器或平台登录，页面不发送网络请求。

可切换两个虚构账号，以及全部、最近更新和无变化导出。两个账号复用招聘者 ID 和消息 ID，但内容不同；fixture 包含媒体摘要、不完整历史和未知发送时间。中英文切换只改变页面界面，消息保留中文原文，语言选择不持久保存。

重新生成页面和 [JSON fixture](../../examples/demo-data/)：

```sh
npm run demo
```

[生成器](../../scripts/generate-demo.mjs) 使用生产导出模块。该页面展示归档与导出语义，不是网站实况截图，也不是扩展内置的聊天浏览器。

## Chromium 回归

安装开发工具和 Chromium 后构建、运行：

```sh
npm ci --ignore-scripts
npm run test:browser:install
npm run build
npm run test:browser
```

Linux 缺少系统库时使用 `npm run test:browser:install -- --with-deps`。包装器使用项目缓存 `node_modules/.cache/boss-browser/`，不清理共享 Playwright 缓存；profile 新建于系统临时目录。Playwright 仅为开发依赖，不进入扩展 ZIP。

测试按公开包清单加载扩展，通过生产存储模块播种两个合成账号，检查：

- 原生 `chrome.storage.local` 密文、不可导出的 IndexedDB CryptoKey，以及弹窗缓存显示。
- 空归档和已有归档的引导、操作区域及合成截图。
- 浏览器语言选择（含 `zh-TW` 和不支持语言回退）、即时切换、快速选择及冷重启后的偏好保留、中文消息原文导出。Node 另覆盖进行中的操作、迟到偏好读取、错误恢复及无障碍/确认文案。
- 招聘者和消息 ID 重合时，导出与清除仍按账号隔离。
- worker 停止和唤醒，以及使用同一临时 profile 完全重启 Chromium 后无需重新播种。

导出与清除通过真实扩展页和生产模块执行，显示检查使用 `popup.html`。headless 环境未自动化验证工具栏 action popup 到 worker 的成功往返；Node 覆盖对应消息处理，更早的一次性原生验收见[验证记录](VERIFICATION.md)。

测试阻断外部网络，不启动采集；仅清理本轮创建并核对过的临时路径。失败截图和 trace 保留在 `test-results/`，HTML 报告位于 `playwright-report/`，使用 `npx playwright show-report` 打开。不自动重试，不做逐像素比较或固定秒数性能门槛。

## CI 与验收范围

推送和 PR 在 Ubuntu、Windows 上运行 Node 24 测试、覆盖率、公开检查和 ZIP 打包，并在 Ubuntu 上运行原生 Chromium 回归。覆盖率及浏览器诊断保留 7 天，运行 ZIP 保留 14 天；CI 不需要 Google 或网站凭据。

手动发布的构建阶段也运行 Chromium 回归；商店行为由所选 operation 决定，见[发布说明](RELEASING.md)。

这些检查不能证明：

- 双真实账号切换、BOSS 当前接口或登录兼容性，或平台限制已解决。
- 所有操作系统、Edge 或 Chrome 最低版本均受支持。
- 已删除历史可恢复、请求速率获平台认可、账号全部历史完整，或商店已批准发布。

参考：[Node 覆盖率](https://nodejs.org/docs/latest-v24.x/api/test.html#collecting-code-coverage)、[Playwright 扩展测试](https://playwright.dev/docs/chrome-extensions)，以及启发 fixture 和测试分层组织的 [Parallel AI 测试工作流](https://github.com/ParkerCai/parallel-ai-extension/blob/main/.github/workflows/test.yml)。
