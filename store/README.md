# Chrome Web Store 提交材料

适用对象：**BOSS 沟通记录本地助手 0.8.11 公开候选版**。本目录用于检查和填写商店草稿；公开源码及隐私政策发布到 GitHub，商店草稿先不提交审核。

## 材料位置

| 材料 | 文件 | 用途 |
| --- | --- | --- |
| 中文商品页 | [listing-zh-CN.md](listing-zh-CN.md) | 名称、简介、详细介绍和截图说明 |
| 隐私表填写说明 | [privacy-disclosure.md](privacy-disclosure.md) | 单一用途、权限理由、数据类型和有限用途说明 |
| 审核备注 | [reviewer-instructions.md](reviewer-instructions.md) | 安装、操作流程、合成演示与真实平台测试边界 |
| 隐私政策正文 | [extension-tracker/PRIVACY.md](../extension-tracker/PRIVACY.md) | 与 0.8.11 一致的公开隐私政策 |
| 本机加密验收 | [acceptance-0.8.11.json](acceptance-0.8.11.json) | 合成数据的原生浏览器验收结果，以文件记录为准 |
| 图标 | `extension-tracker/icons/icon-16.png`、`icon-32.png`、`icon-48.png`、`icon-128.png` | 扩展包内图标；相对本目录位于 `../extension-tracker/icons/` |
| 小型宣传图 | `assets/small-promo.png` | 440 × 280 PNG |
| 截图 | `assets/screenshot-overview.png`、`assets/screenshot-no-changes.png` | 1280 × 800 PNG，真实扩展界面中的合成数据 |

源码压缩包供阅读和离线复现；商店运行包只包含扩展运行文件，`manifest.json` 必须位于 ZIP 根目录。[软件包要求](https://developer.chrome.com/docs/webstore/prepare)

商店当前要求扩展图标、小型宣传图和至少一张截图。本目录使用 128 × 128 PNG 图标、440 × 280 宣传图和 1280 × 800 截图；大幅宣传图和视频本轮不准备。[图片要求](https://developer.chrome.com/docs/webstore/images)

## 开发者后续填写

以下内容依赖开发者账号及发布决定，材料中不代填身份信息，也不索取密码、验证码或浏览器 Cookie。

- 支持邮箱和商店公开联系方式。
- 开发者名称、所在国家或地区、身份验证及后台要求的交易者状态。
- 发行地区、可见性、定价设置与最终商店分类；分类建议选生产效率相关类别，以后台选项为准。
- 商店隐私政策字段填写 [公开隐私政策 URL](https://github.com/L1pp/boss-chat-recorder/blob/main/extension-tracker/PRIVACY.md)，提交前核对页面为 0.8.11 内容并可免登录访问。
- 审核后台如要求额外测试说明，由开发者补充适当测试安排；不要提供日常使用账号的密码或真实聊天导出。

项目主页为 [GitHub 仓库](https://github.com/L1pp/boss-chat-recorder)，支持页面可使用 [GitHub Issues](https://github.com/L1pp/boss-chat-recorder/issues)。隐私政策为 [公开政策页面](https://github.com/L1pp/boss-chat-recorder/blob/main/extension-tracker/PRIVACY.md)，与本目录中的政策正文同源。

## 本轮范围

加密和重启持久化使用隔离浏览器配置、合成账号与合成消息验收，不读取现用浏览器真实记录。图片不含真实求职数据；独立演示页面不冒充已安装扩展功能。

这份材料不表示商店已经批准，也不表示网站限制已消除。真实平台采集范围沿用已有验证记录；本轮不使用真实账号重测，多真实账号切换继续暂缓。
