# 测试与证据范围

测试分为两层：Node 离线回归验证数据与控制逻辑；独立 Chromium 验证原生扩展 API、加密存储和浏览器生命周期。两层都使用合成数据，不登录 BOSS，不读取维护者的浏览器配置或聊天数据，不连接商店。

## Node 离线回归

Node.js 24 或更新版本即可运行，无需安装第三方依赖：

```sh
npm test
npm run check
```

现有测试覆盖会话增量选择、消息去重、分页与异常暂停、账号分区、迟到消息拒绝、导出范围、存储提交与恢复、弹窗状态，以及发布客户端的合成 HTTP 响应。测试使用替代的 Chrome API、DOM、IndexedDB 或 fetch；这些结果不能替代真实浏览器 API 和真实平台验收。

`check` 验证已提交 bundle 与源码生成结果一致、公开文件范围、许可证和版本、合成示例及有限的敏感模式。它不连接外部网站，也不能证明所有个人信息都已被识别。`node_modules/`、测试报告、覆盖率和 `dist/` 是忽略的生成目录；扩展 ZIP 仍只从明确列出的公开运行文件生成。

## 覆盖率

```sh
npm run test:coverage
```

使用 Node 原生 V8 覆盖率，输出终端摘要和 `coverage/lcov.info`。报告针对本次 Node 测试实际执行到的 `extension-tracker/` 和 `scripts/` 文件；没有加载的文件不一定进入报告，通过 VM / data URL 执行的代码也可能不能映射回源文件。Chromium 测试不计入这份覆盖率。它用于定位未覆盖逻辑，不是全项目正确率或平台兼容率，没有百分比通过门槛。

## Chromium 合成回归

首次安装测试工具与 Chromium：

```sh
npm ci --ignore-scripts
npm run test:browser:install
npm run build
npm run test:browser
```

Linux 若缺少浏览器系统库，运行 `npm run test:browser:install -- --with-deps`。安装和测试包装器统一使用本项目 `node_modules/.cache/boss-browser/`，不清理共享 Playwright 缓存；Chromium 配置另建于系统临时目录。Playwright 仅为开发依赖，不进入商店扩展 ZIP。

测试按公开包清单实际加载扩展，用仓库中的两个合成账号和生产存储模块播种数据，验证：

- 真实 `chrome.storage.local` 的受保护归档为密文，原生 IndexedDB 的 AES-GCM CryptoKey 不可导出，popup 能显示本地缓存。
- 使用空记录和已有记录的合成本地缓存，验证首次引导、主按钮与操作区域的实际浏览器显示，并保存合成界面截图。
- 两个合成账号复用招聘者与消息 ID 时，导出和清除仍按账号隔离。
- 真正停止并唤醒扩展 worker、完全关闭 Chromium 后以同一临时 profile 重启，无需重新播种即可读取和导出。

导出与清除通过真实扩展页调用生产存储和导出模块；缓存显示使用 `popup.html` 页面。当前 headless 环境没有提供可自动化的 action popup 视图，因此尚未验证工具栏弹窗到后台的成功消息往返；该消息处理逻辑仍由 Node 测试覆盖。

浏览器测试阻断外部网络，不启动采集。每次结束只清理本次创建并核对路径的临时目录，不使用个人 Chrome/Edge profile。

失败时保留合成页面截图和 trace；HTML 报告位于 `playwright-report/`，附件位于 `test-results/`。可用 `npx playwright show-report` 查看。测试不自动重试，不做截图逐像素比较或固定秒数性能阈值。

## GitHub Actions

推送和 PR 自动运行：

- Ubuntu 与 Windows 上的 Node 24 离线测试、覆盖率、公开源码检查及 ZIP 打包。
- Ubuntu 上实际加载扩展的 Chromium 合成回归。
- 覆盖率和浏览器诊断报告保留 7 天，公开运行 ZIP 保留 14 天。CI 不需要 Google 身份、发布令牌或真实网站账号。

手动发布工作流的构建阶段同样运行浏览器回归；上传或提交只在明确选择相应操作且测试成功后执行。`status` 仍只查询商店，不运行浏览器测试、上传或提交。见 [发布说明](RELEASING.md)。

## 仍需人工验证的边界

- Chromium 合成账号隔离不能证明双真实账号切换已经验收。
- 离线分页与增量测试不能证明 BOSS 当前接口、账号状态或风控兼容性。
- 当前 Chromium 通过，不代表 Chrome 最低支持版本、Edge 或所有操作系统组合都已通过。
- 自动测试通过不代表网站已删除的历史能够恢复，不代表平台认可采集速率，也不代表发布已获商店审核批准。

实现指南：[Node 测试覆盖率](https://nodejs.org/docs/latest-v24.x/api/test.html#collecting-code-coverage)、[Playwright 扩展测试](https://playwright.dev/docs/chrome-extensions)。测试分层和本地合成 fixture 的组织方式也参考了 [Parallel AI 的测试工作流](https://github.com/ParkerCai/parallel-ai-extension/blob/main/.github/workflows/test.yml)。
