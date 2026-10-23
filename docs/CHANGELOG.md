# Changelog

[English](CHANGELOG.md) | [简体中文](zh-CN/CHANGELOG.md)

Notable public-source changes. Internal versions and unreleased entries do not establish Chrome Web Store publication; dated acceptance evidence is in [VERIFICATION.md](VERIFICATION.md).

## Unreleased

- Add Linux and Windows offline checks, synthetic Linux Chromium regression, and LCOV reports without a coverage-percentage gate.
- Add contribution/security guidance and issue/pull request templates.
- Organize developer documentation in `docs/`, Chinese counterparts in `docs/zh-CN/`, and GitHub community guidance in `.github/`; shorten root READMEs and link to dedicated guides.

## 0.8.12 (unreleased)

- Add first-collection guidance, a BOSS chat-page link, and retry handling; show actions according to local archive, resume, and verification state.
- Keep per-account collection history so a zero-record completion followed by a tab change does not reopen the welcome view. Progress and stop remain tied to the current tab.
- Add Chinese/English popup text, browser-language selection with an English fallback, and a locally remembered language switch. Saved chats and exports retain their original language.
- Default developer documentation to English and retain linked Chinese versions.

## 0.8.11

- Encrypt new local archive writes with AES-GCM and a browser-persisted key, without a password or unlock step. Retain compatibility reads for old plaintext without converting the whole archive.
- Keep user-exported JSON in plaintext; do not automatically upload records to AI services.
- Verify encrypted storage, worker stop/wake, and browser restart reads/exports with synthetic accounts in isolated Chromium. Two-real-account switching remains unverified.
