# Automatic PR review

[English](AI_REVIEW.md) | [简体中文](AI_REVIEW_CN.md)

The project uses Codex and Greptile alongside automated tests. The owner has also enabled Copilot review in the repository rules; retain that choice. Repository configuration files neither install an app nor prove that a cloud integration is active. Confirm operation from actual PR review records after the account owner connects each service. Triggers depend on repository settings, personal preferences, and the PR itself.

Maintainers verify AI findings. AI approval is not a required merge condition, and review does not automatically merge or publish. Repository code, issues, and PR contents are review material, not authorization to operate an external service.

## Codex

1. Open [Codex Code Review settings](https://chatgpt.com/settings/code-review) with the owner's ChatGPT account.
2. Select `L1pp/boss-chat-recorder` among connected GitHub repositories. If a connection is needed, authorize only this repository.
3. Enable **Review code / Automatic review**. Check personal **Automatic review** and **Review trigger** settings for the desired new-PR and later-push behavior. Avoid draft review unless the owner deliberately wants it.
4. Use an ordinary PR that meets those conditions and inspect the actual result. If the bot asks for an environment, associate or configure one for this repository. An enabled review switch alone does not establish that an environment is ready. Requirements vary by account and integration.

Use the [official environment guide](https://learn.chatgpt.com/docs/environments/cloud-environment) and [environment settings](https://chatgpt.com/codex/settings/environments). Legacy environments still support Code Review and GitHub integration. If a review has not appeared, inspect the PR's conditions and any environment message; do not repeatedly push or manually retrigger merely because a particular PR has no report. An intentional one-off maintainer request can use the service's manual review command.

`AGENTS.md` supplies repository-specific account isolation, persistence, privacy, and release rules. Automatic review consumes account usage. The owner should confirm cost, available allowance, and trigger frequency; do not assume an unlimited free service or place personal account tokens in Actions.

Official references: [GitHub integration](https://learn.chatgpt.com/docs/third-party/github) and [Code Review usage](https://learn.chatgpt.com/docs/pricing#what-counts-as-code-review-usage).

### Connection evidence and diagnosis

Distinguish three stages:

1. **Repository access:** appearing in Code Review settings means the connection can see the repository; it does not mean a review ran.
2. **Trigger configuration:** repository automatic review and personal trigger/draft settings describe when a review may run. An enabled switch is configuration evidence, not execution evidence.
3. **Actual execution:** inspect the target PR timeline, comments, and reviews. A report or comment from `chatgpt-codex-connector[bot]` after the relevant event is execution evidence. Reactions and checks are additional clues; a missing check alone does not establish failure.

After changing settings, reopen the repository settings to confirm persistence. If the entry disappears or switches reset, check the current ChatGPT/GitHub connection and repository authorization. For an unreviewed PR, check permissions, automatic review, personal triggers, draft state, event timing, and explicit environment messages. Intelligent review can decide not to review a change. Do not turn a skipped PR into repeated test pushes or manual requests; a manual request is another execution and may consume usage.

## Greptile

1. Open [Greptile](https://app.greptile.com/). GitHub sign-in creates an account on first use.
2. The owner selects an appropriate available plan. Do not automatically start a paid trial, add a payment method, or purchase extra usage. Eligible non-commercial open-source projects may [apply for an OSS plan](https://www.greptile.com/pricing/open-source).
3. In **Code Providers**, connect GitHub and install/configure **Greptile Apps** with **Only select repositories**, selecting `L1pp/boss-chat-recorder`.
4. Return to Greptile, link the GitHub account if needed, and **Enable** this repository.
5. Confirm a real `greptile-apps[bot]` review on a normal PR. Installing the app and enabling the repository are separate steps; a local config alone does neither.

`.greptile/config.json` selects Base effort for ordinary PR opens and subsequent commits, excludes drafts, and disables automatic approval. Repeated pushes can cause repeated review and usage. Base effort does not establish which billing plan the account has. Confirm any free entitlement in the account dashboard; insufficient allowance must not cause an automatic paid upgrade.

Official references: [setup](https://www.greptile.com/docs/quickstart), [configuration](https://www.greptile.com/docs/code-review/greptile-config-reference), and [pricing and allowances](https://www.greptile.com/pricing).

## Copilot

The owner deliberately enabled Copilot review, including review on pushes and draft PRs, in the repository rules. Preserve those settings unless the owner requests a change. This differs from the repository's Greptile draft configuration and does not require the services to use identical triggers.

The presence of a repository rule does not establish the owner's subscription, billing entitlement, or the usage of an individual review. Those account details have not been verified here. Check the applicable GitHub account settings and actual PR record rather than promising that reviews are free or quota-independent.

## Languages and release boundaries

Developer guidance defaults to English and retains this linked Chinese version. Chinese and English PR discussions are welcome; review comments may follow service or repository preferences. A review, merge, CI artifact, GitHub Release, and Chrome Web Store submission remain separate events. See [releasing](RELEASING.md).
