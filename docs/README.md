# Documentation

[English](README.md) | [简体中文](zh-CN/README.md) · [Project overview](../README.md)

| Topic | Guide |
| --- | --- |
| Install, collect, export, and troubleshoot | [Usage](USAGE.md) |
| Components, account isolation, and local storage | [Architecture](ARCHITECTURE.md) |
| Build, test, and inspect synthetic examples | [Testing](TESTING.md) |
| Actions packaging and store operations | [Releasing](RELEASING.md) |
| Configure optional automatic reviewers | [AI review](AI_REVIEW.md) |
| Recorded results and acceptance limits | [Verification](VERIFICATION.md) |
| Version history | [Changelog](CHANGELOG.md) |
| Code origin and license | [Provenance](PROVENANCE.md) |
| Submit issues and pull requests | [Contributing](../.github/CONTRIBUTING.md) |
| Report a vulnerability privately | [Security](../.github/SECURITY.md) |
| Data handling | [Privacy policy](../extension-tracker/PRIVACY.md) |

## Repository layout

| Directory | Purpose |
| --- | --- |
| `extension-tracker/` | Loadable extension runtime and generated collection bundles |
| `scripts/` | Collection sources, build, test, and release helpers |
| `tests/` | Offline and synthetic Chromium regression |
| `examples/` | Synthetic JSON fixtures and offline preview |
| `store/` | Listing, artwork, disclosures, and reviewer material |
| `.github/` | Community guidelines, issue/PR templates, and Actions workflows |
| `docs/zh-CN/` | Chinese guides, matching the English topics |

The root keeps the project overview, license, agent guidance, and tool-required configuration. Detailed instructions have one primary home rather than being repeated in the README.
