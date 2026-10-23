# Contributing

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING_CN.md)

Thank you for helping improve BOSS Chat Recorder. This repository uses the MIT License, and contributions are provided under the same license. Chinese and English issues and pull requests are welcome.

The project is maintained by an individual. Reports and pull requests are reviewed as time allows; there is no response-time, feature-acceptance, or platform-support commitment. Keep proposals focused on reproducible problems, clear changes, and synthetic data.

## Local development and checks

Use Node.js 24 or later. Unit tests use Node's built-in test runner:

```sh
npm test
npm run check
```

Coverage is reported without a passing percentage threshold:

```sh
npm run test:coverage
```

For real browser tests with synthetic data, install the development tools and Chromium first:

```sh
npm ci --ignore-scripts
npm run test:browser:install
npm run test:browser
```

Playwright is a development dependency. It is not included in the extension runtime package and adds no extension permissions. GitHub Actions runs Linux and Windows offline checks plus isolated Linux Chromium tests. Tests do not log in to BOSS, read real chats, send messages, or submit applications. See [testing](docs/TESTING.md) / [测试说明](docs/TESTING_CN.md).

## Issues and pull requests

- For a bug, include the extension version, reproduction steps, expected behavior, and actual behavior. Use synthetic fixtures and only necessary, redacted error codes or log excerpts.
- For a feature, describe the concrete problem, desired behavior, and existing workaround. A proposal does not establish a commitment to implement a feature or support a platform.
- For a pull request, explain the behavior change and checks you ran. Changes to collection, account separation, permissions, encryption, or exports should include focused offline tests and appropriate privacy documentation.
- Keep each PR focused. Open it from a branch, let configured CI and AI reviews run when their conditions apply, and address relevant feedback before merge. The final store package is built by GitHub Actions from merged `main`; local and PR CI ZIPs are previews. Publishing is a separate manual operation.
- Do not put real chats, account UIDs, recruiter contact information, verification codes, Cookies, pairing tokens, keys, or complete real exports in issues, PRs, screenshots, or attachments. Report vulnerabilities privately under [SECURITY.md](SECURITY.md) / [安全报告](SECURITY_CN.md).
- Do not add access to real accounts, message sending, resume submission, or platform-verification bypass to automated checks or demos.

Submitting a PR does not guarantee acceptance. A maintainer may request changes, defer a proposal, or close work outside the project's scope.

## Languages

English is the default for developer documentation, with linked Chinese versions. Preserve Chinese documentation rather than replacing it. The user interface serves a mainly Chinese market: support Chinese and English without translating saved message content. Keep both interface translations and language-specific documents consistent when behavior changes. BOSS names and Chinese examples may remain in Chinese where they help explain the product.

Configured Codex, Greptile, and owner-enabled Copilot reviews are additional feedback, not automatic approval or publishing. Account settings and usage depend on the service; see [AI review](docs/AI_REVIEW.md) / [AI 审阅说明](docs/AI_REVIEW_CN.md).
