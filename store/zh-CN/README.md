# Chrome Web Store 材料

[English](../README.md) | [简体中文](README.md)

图片与验收记录的基线为 **0.8.11**，也是本仓库最后记录的商店已发布版本。当前源码 **0.8.12** 仍待发布。本目录不是实时商店状态报告；后续提交时应让文案与所选软件包一致。

维护者说明默认英文，商品页面向主要用户市场保留中文，各维护指南也保留中文对应版本。

## 材料位置

| 材料 | 位置 |
| --- | --- |
| 面向用户的商品页文案 | [中文商品页](listing.md) |
| 隐私表填写说明 | [English](../privacy-disclosure.md) / [中文](privacy-disclosure.md) |
| 审核备注 | [English](../reviewer-instructions.md) / [中文](reviewer-instructions.md) |
| 公开隐私政策 | [extension-tracker/PRIVACY.md](../../extension-tracker/PRIVACY.md) |
| 原生浏览器验收记录 | [acceptance-0.8.11.json](../acceptance-0.8.11.json) |
| 运行包图标 | [icons/](../../extension-tracker/icons/) — 16、32、48、128 px |
| 宣传图 | [small-promo.png](../assets/small-promo.png) — 440 × 280 |
| 合成截图 | [概览](../assets/screenshot-overview.png)、[无变化](../assets/screenshot-no-changes.png) — 1280 × 800 |

截图来自实际扩展中的合成记录，标明“合成演示数据”，保留基线版本界面，不代表待发布界面。图片不含真实求职记录。独立的[离线演示](../../examples/index.html)用于说明账号与导出行为，并非扩展内置的聊天浏览器。

验收记录使用隔离浏览器配置和合成账号检查加密与重启持久化，不能证明当前网站兼容性或双真实账号切换。真实平台范围见[验证记录](../../docs/zh-CN/VERIFICATION.md)。

## 准备提交

账号所有者确认后台联系方式、身份资料、必要声明、发行设置和分类。审核材料不应包含日常账号凭据或真实聊天导出。

隐私政策使用稳定的[公开 URL](https://github.com/L1pp/boss-chat-recorder/blob/main/extension-tracker/PRIVACY.md)，并确认可免登录访问且与提交包一致。项目主页：[GitHub](https://github.com/L1pp/boss-chat-recorder)；问题反馈：[Issues](https://github.com/L1pp/boss-chat-recorder/issues)。

打包和已获授权的商店操作见[发布说明](../../docs/zh-CN/RELEASING.md)。运行 ZIP 只包含运行文件，manifest.json 位于根目录。提交前核对 Google 的[软件包](https://developer.chrome.com/docs/webstore/prepare)与[图片](https://developer.chrome.com/docs/webstore/images)要求。
