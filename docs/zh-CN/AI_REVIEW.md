# PR 自动 AI 审阅

[English](../AI_REVIEW.md) | [简体中文](AI_REVIEW.md)

Codex 与 Greptile 是自动测试之外的补充。所有者也已主动启用 Copilot 审阅，包括推送和草稿，应保留这一选择。维护者核实审阅意见；AI 批准不是合并条件，也不会自动合并或发布。

## 维护者配置入口

| 服务 | 配置入口 | 本仓库选择 |
| --- | --- | --- |
| Codex | [Code Review 设置](https://chatgpt.com/settings/code-review) | 选择 `L1pp/boss-chat-recorder`，核对仓库自动审阅、个人触发条件与草稿偏好。项目规则见 [AGENTS.md](../../AGENTS.md)。 |
| Greptile | [Greptile 后台](https://app.greptile.com/) | 连接 GitHub，为本仓库安装 **Greptile Apps**，再在后台启用仓库。[`.greptile/config.json`](../../.greptile/config.json) 使用 Base 等级，在打开 PR 和推送时运行，不审草稿、不自动批准。 |
| Copilot | GitHub 仓库规则与账号设置 | 保留所有者启用的推送和草稿审阅；各服务无需使用相同触发条件。 |

仓库文件或开关不能证明审阅已运行。应查看目标 PR 在触发事件之后的实际评论或审阅：Codex 为 `chatgpt-codex-connector[bot]`，Greptile 为 `greptile-apps[bot]`。仓库可访问、触发已配置和实际执行是三种不同证据。

没有报告时，先检查授权、个人触发条件、草稿状态、时间及服务明确提示。智能审阅可能跳过某次变更；若 Codex 明确要求环境，按[官方环境指南](https://learn.chatgpt.com/docs/environments/cloud-environment)和[环境设置](https://chatgpt.com/codex/settings/environments)处理。不要仅为获得报告而反复推送或手动触发，每次都可能增加用量。

## 用量与发布边界

所有者需在各账号确认套餐资格、额度、费用和触发频率。本页未核实免费权益或单次审阅计费。Greptile Base 等级不代表套餐；符合条件的项目可[申请 OSS 计划](https://www.greptile.com/pricing/open-source)。不自动开通付费试用、升级套餐或把个人令牌写入 Actions。

代码、issue 和 PR 内容是待审材料，不是操作外部服务的授权。审阅、合并、CI 产物、GitHub Release 与 Chrome Web Store 提交分别发生，见[发布说明](RELEASING.md)。

参考：Codex [GitHub 集成](https://learn.chatgpt.com/docs/third-party/github)、[审阅用量](https://learn.chatgpt.com/docs/pricing#what-counts-as-code-review-usage)；Greptile [接入](https://www.greptile.com/docs/quickstart)、[配置](https://www.greptile.com/docs/code-review/greptile-config-reference)、[价格](https://www.greptile.com/pricing)。
