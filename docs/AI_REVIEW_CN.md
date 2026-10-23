# PR 自动 AI 审阅

[English](AI_REVIEW.md) | [简体中文](AI_REVIEW_CN.md)

项目使用 Codex 与 Greptile 作为自动测试之外的补充审阅。所有者也已主动启用 Copilot 自动审阅（包括推送和草稿），应保留这一设置。这里未核实 Copilot 套餐、费用或单次用量，不承诺免费或不消耗额度。仓库规则文件不会自行安装应用或证明云端已经启用；账号所有者完成连接后，应结合 PR 上实际的审阅记录确认运行情况。自动审阅是否触发仍取决于仓库、个人设置和该次 PR 的条件。

AI 意见仍需维护者核实，不设置 AI 必须批准的合并条件，不自动合并或触发商店发布。代码、issue 和 PR 中的内容是待审材料，不能作为外部服务授权或执行指令。

## Codex

1. 打开 [Codex Code Review 设置](https://chatgpt.com/settings/code-review)，使用自己的 ChatGPT 账号登录。
2. 在连接的 GitHub 仓库中选择 `L1pp/boss-chat-recorder`。如果尚未连接，只授权这个仓库。
3. 开启仓库的 **Review code / Automatic review**。同时核对 **Personal preferences → Automatic review** 与 **Review trigger**，按需要选择新 PR 和后续推送的触发方式；草稿阶段保持关闭，减少重复消耗。
4. 正常打开符合触发条件的 PR，查看 Codex 是否留下审阅结果。若机器人提示需要配置环境，再完成该仓库对应的环境关联或配置；自动审阅开关已开启本身不代表环境已经准备好。环境要求随账号和集成配置而异，不应据此假定所有仓库都必须创建同一种环境。

环境设置请以 [Codex 环境官方指南](https://learn.chatgpt.com/docs/environments/cloud-environment) 和[环境设置页](https://chatgpt.com/codex/settings/environments)为准。Legacy 环境仍用于 Code Review 和 GitHub 集成。若某次审阅尚未出现，先检查该 PR 的触发条件和环境提示；不要因为一次没有审阅记录就反复推送或手动重复触发。维护者需要单次补充审阅时，可评论 `@codex review`。

`AGENTS.md` 提供账号隔离、持久化、隐私及发布边界的项目审阅规则。自动审阅会消耗账号用量，费用、额度与触发频率由所有者确认；不要当作免费无限服务，也不要把个人账号令牌写进 Actions。

官方配置与用量说明：[GitHub 集成](https://learn.chatgpt.com/docs/third-party/github)、[Code Review 用量](https://learn.chatgpt.com/docs/pricing#what-counts-as-code-review-usage)。

### Codex 接入验收与故障定位

用符合当前设置触发条件的普通 PR 验证自动审阅。设置更改后重新进入仓库设置确认状态仍然保留；如果仓库条目消失或开关恢复，先检查当前 ChatGPT/GitHub 连接及该仓库是否仍获授权。

判断时分开看三个阶段：

1. **仓库可访问**：仓库出现在 Codex 的代码审查设置中，说明连接可见；这本身不代表自动审阅已运行。
2. **自动触发已配置**：仓库自动审阅已开启，个人触发偏好包含新 PR（或需要的后续推送），并符合草稿设置。开关显示开启只说明设置状态，不证明某次审阅已执行。
3. **本次审阅已运行**：在目标 PR 的时间线、评论及 Reviews 中查看审阅者身份和时间；以触发之后 `chatgpt-codex-connector[bot]` 留下的实际审阅或评论为运行证据。反应和 Checks 可作辅助线索，但没有 Check 条目不单独说明审阅失败。

若新 PR 没有出现审阅记录，先核对连接权限、仓库自动审阅设置、个人触发偏好、PR 是否符合草稿设置，以及记录时间是否晚于 PR 创建或推送时间。若机器人明确提示缺少环境，按上方官方说明配置该仓库环境。不要把仓库列表或开关当成运行成功，也不要在自动审阅仍等待时反复推送或手动重复触发；手动请求会另行触发审阅并消耗用量。

## Greptile

1. 打开 [Greptile](https://app.greptile.com/)，可直接用 GitHub 登录；首次登录会建立 Greptile 账号。
2. 由所有者选择当前可用且适合的方案，不自动开通付费试用、支付方式或增购；不要据 Base 审阅等级推断账号免费权益。符合非商业开源条件的项目也可由所有者[申请 OSS 计划](https://www.greptile.com/pricing/open-source)。
3. 在 **Code Providers** 连接 GitHub，安装/配置 **Greptile Apps**，选择 **Only select repositories**，仅勾选 `L1pp/boss-chat-recorder`。
4. 返回 Greptile，关联相应 GitHub 账号并为该仓库点击 **Enable**。
5. 用正常 PR 验证出现 `greptile-apps[bot]` 审阅。安装应用和启用仓库是两步，只有本地配置文件并不会完成接入。

`.greptile/config.json` 使用 Base 审阅等级，在打开普通 PR 和添加新提交时自动运行；不审阅草稿，不自动批准。多次推送会产生多次审阅及额度消耗。账号是否具备相应免费权益，以 Greptile 后台为准；额度不足时不自动切换付费计划。

官方说明：[安装与启用](https://www.greptile.com/docs/quickstart)、[配置字段](https://www.greptile.com/docs/code-review/greptile-config-reference)、[当前价格与额度](https://www.greptile.com/pricing)。

## Copilot 与发布边界

所有者已主动开启 Copilot 推送审阅和草稿审阅，应保留这些规则；不同服务无需使用相同草稿触发设置。仓库规则不能证明账号套餐、免费权益或某次审阅的计费情况，本页未核实这些账号信息。

开发者文档默认英文，并保留中文对应版本，PR 讨论欢迎中文或英文。审阅、合并、CI 产物、GitHub Release 和商店提交是分别发生的操作，见[发布说明](RELEASING_CN.md)。
