# Contributing

[English](CONTRIBUTING.md) | [简体中文](../docs/zh-CN/CONTRIBUTING.md)

Chinese and English issues and pull requests are welcome. The project and contributions use the MIT License. An individual maintains this repository as time allows, without response-time, feature-acceptance, or platform-support commitments.

## Getting started

Use Node.js 24 or later. See [testing](../docs/TESTING.md) for setup, commands, and test scope, and [releasing](../docs/RELEASING.md) for packaging and store operations.

## Issues and pull requests

- For bugs, include the affected version, minimal reproduction, expected behavior, and actual result. For features, describe the problem, desired behavior, and current workaround.
- Keep each PR focused and submit it from a branch. Explain the behavior change and validation, including relevant checks not run. Let configured CI and AI reviews run when their conditions apply, and address relevant feedback before merge. See [AI review](../docs/AI_REVIEW.md) for review scope.
- Changes to collection, account separation, permissions, encryption, or exports should include focused offline tests and any needed privacy documentation.
- Use synthetic fixtures and fresh browser profiles. Automated checks and demos must not access real accounts, send messages, submit applications, or bypass platform verification.
- Exclude real chats, UIDs, recruiter contacts, complete exports, and credentials such as Cookies, codes, tokens, or keys from public reports and attachments. Report vulnerabilities privately under [security reporting](SECURITY.md).

## Languages

Developer documentation defaults to English with linked Chinese versions. Update both when behavior changes. Keep Chinese and English interface text consistent, without translating saved messages. BOSS names and Chinese examples may remain in Chinese where useful.
