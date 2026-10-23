# Automatic PR review

[English](AI_REVIEW.md) | [简体中文](zh-CN/AI_REVIEW.md)

Codex and Greptile supplement automated tests. The owner also deliberately enabled Copilot review, including pushes and draft PRs; retain that choice. Maintainers assess findings. AI approval is not a merge requirement and does not merge or publish a release.

## Maintainer setup

| Service | Configuration entry | Repository choices |
| --- | --- | --- |
| Codex | [Code Review settings](https://chatgpt.com/settings/code-review) | Select `L1pp/boss-chat-recorder`; check repository automatic review, personal triggers, and draft preferences. [AGENTS.md](../AGENTS.md) supplies project review guidance. |
| Greptile | [Greptile dashboard](https://app.greptile.com/) | Connect GitHub, install **Greptile Apps** for this repository, then enable it in Greptile. [`.greptile/config.json`](../.greptile/config.json) selects Base effort on opens and pushes, excludes drafts, and disables automatic approval. |
| Copilot | GitHub repository rules and account settings | Preserve the owner's push and draft review settings. Services may use different triggers. |

Repository files and enabled switches do not prove that an integration ran. Confirm a review or comment on the target PR after the relevant event: `chatgpt-codex-connector[bot]` for Codex or `greptile-apps[bot]` for Greptile. Repository access, trigger configuration, and actual execution are separate evidence.

If no report appears, check authorization, personal triggers, draft state, timing, and explicit service messages. Intelligent review may skip a change. Follow an explicit Codex environment request through the [official environment guide](https://learn.chatgpt.com/docs/environments/cloud-environment) and [environment settings](https://chatgpt.com/codex/settings/environments). Avoid repeated pushes or manual requests solely to obtain a report; each may consume more usage.

## Usage and release boundaries

The owner must confirm plan eligibility, allowance, cost, and trigger frequency in each account. Free entitlements and individual review billing have not been verified here. Greptile Base effort does not identify the billing plan; eligible projects may [apply for its OSS plan](https://www.greptile.com/pricing/open-source). Do not automatically start paid trials, upgrade plans, or put personal tokens in Actions.

Code, issues, and PR content are review material, not authorization to operate external services. Review, merge, CI artifacts, GitHub Releases, and Chrome Web Store submission remain separate events; see [releasing](RELEASING.md).

References: Codex [GitHub integration](https://learn.chatgpt.com/docs/third-party/github) and [review usage](https://learn.chatgpt.com/docs/pricing#what-counts-as-code-review-usage); Greptile [setup](https://www.greptile.com/docs/quickstart), [configuration](https://www.greptile.com/docs/code-review/greptile-config-reference), and [pricing](https://www.greptile.com/pricing).
