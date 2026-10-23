# Chrome Web Store materials

[English](README.md) | [简体中文](README_CN.md)

These materials were prepared for **BOSS 沟通记录本地助手 0.8.11**. They retain the store-artwork and disclosure baseline. Source 0.8.12 is an unreleased candidate; bilingual documentation does not upload a new package, change a listing, or submit a review. The last published version documented by the repository is 0.8.11, without a fresh store-status check implied by this file.

Developer-facing instructions default to English. The [Chinese listing draft](listing-zh-CN.md) remains Chinese for the product's primary market, and linked Chinese versions of this guidance are retained. The public [privacy-policy path](../extension-tracker/PRIVACY.md) is unchanged.

## Materials

| Material | File | Purpose |
| --- | --- | --- |
| Chinese listing | [listing-zh-CN.md](listing-zh-CN.md) | Name, summary, description, and screenshot captions |
| Privacy form guidance | [privacy-disclosure.md](privacy-disclosure.md) / [中文](privacy-disclosure_CN.md) | Single purpose, permission reasons, data types, and Limited Use disclosure |
| Reviewer notes | [reviewer-instructions.md](reviewer-instructions.md) / [中文](reviewer-instructions_CN.md) | Installation, operation, synthetic demonstration, and live-platform limits |
| Privacy policy | [extension-tracker/PRIVACY.md](../extension-tracker/PRIVACY.md) | Public policy supplied with the 0.8.11 baseline |
| Native encryption acceptance | [acceptance-0.8.11.json](acceptance-0.8.11.json) | Actual synthetic native-browser results; use the recorded scope |
| Icons | `../extension-tracker/icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png` | Icons included in the runtime package |
| Small promotional image | `assets/small-promo.png` | 440 × 280 PNG |
| Screenshots | `assets/screenshot-overview.png`, `assets/screenshot-no-changes.png` | 1280 × 800 PNG showing synthetic records in the actual extension |

A source archive supports inspection and offline reproduction. The store ZIP contains only runtime files and must put `manifest.json` at its root. See [package requirements](https://developer.chrome.com/docs/webstore/prepare).

The prepared artwork consists of a 128 × 128 icon, a 440 × 280 promotional image, and 1280 × 800 screenshots. A large promotional image and video are not included. Check the dashboard and [image requirements](https://developer.chrome.com/docs/webstore/images) before a future submission; this file is not a live dashboard inventory.

## Account-owner responsibilities

Account-specific and publication choices belong to the developer. These materials do not request passwords, verification codes, or browser Cookies.

- Confirm the support email and public store contact details.
- Confirm the developer name, country or region, identity checks, and any dashboard-required trader declaration.
- Choose distribution regions, visibility, pricing, and category. Productivity is the suggested category, subject to available dashboard choices.
- Keep the store policy field pointed to the [public privacy policy](https://github.com/L1pp/boss-chat-recorder/blob/main/extension-tracker/PRIVACY.md), and check that it is accessible without login and matches the submitted behavior.
- If reviewers need more testing information, arrange appropriate conditions without supplying everyday account passwords or real chat exports.

Project home: [GitHub repository](https://github.com/L1pp/boss-chat-recorder). Support: [GitHub Issues](https://github.com/L1pp/boss-chat-recorder/issues). Public policy: [PRIVACY.md](https://github.com/L1pp/boss-chat-recorder/blob/main/extension-tracker/PRIVACY.md), from the same source as the local policy.

## Evidence boundaries

Encryption and restart persistence were accepted with isolated browser profiles, synthetic accounts, and synthetic messages. Artwork contains no real job-search records. The standalone demo does not impersonate additional installed-extension functionality.

These materials alone establish neither store approval nor the removal of website restrictions. Real-platform collection remains limited to the recorded acceptance scope. No new real-account test is implied by localization, and two-real-account switching remains deferred. Use the [release workflow](../docs/RELEASING.md) for later authorized packaging and store operations.
