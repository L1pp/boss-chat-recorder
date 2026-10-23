# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG_CN.md)

This file records notable public-source changes. Internal development versions and unreleased entries do not establish what is published on the Chrome Web Store.

## Unreleased

### Development and tests

- Add Linux and Windows offline checks and synthetic Linux Chromium regression.
- Add LCOV coverage reports for inspection, without a passing-percentage gate.
- Add contribution and security guidance plus issue and pull request templates.

## 0.8.12 (unreleased)

- Show dedicated first-collection guidance and a first-collection action; use local state to distinguish existing archives, resumable runs, and manual verification.
- Link to the BOSS chat page while retaining existing page recognition; allow retry after a failed start and leave the welcome view when progress appears.
- Preserve per-account collection history so that completing a run with zero records and then opening another tab does not incorrectly show the welcome view. Progress and stop operations remain tied to the current tab.
- Add Chinese and English popup text, initial browser-language selection with an English fallback, and a locally remembered language switch. Saved chats retain their original language.
- Use English developer documentation by default and retain linked Chinese versions, including README, contribution, security, architecture, testing, and release guidance.

## 0.8.11

### Features

- Encrypt new local archive writes with AES-GCM and a browser-persisted key, without requiring a password or unlock step.
- Keep compatibility reads for existing plaintext archives; do not automatically convert all retained data.
- Keep user-exported JSON in plaintext. The extension does not automatically upload records to an AI service.

### Verification scope

- Use synthetic accounts in isolated Chromium to verify encrypted storage, worker stop/wake, and reading/export after browser restart.
- Two-real-account switching has not been verified. Offline isolation tests do not replace that acceptance.
