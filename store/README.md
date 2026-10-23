# Chrome Web Store materials

[English](README.md) | [简体中文](zh-CN/README.md)

The artwork and recorded acceptance baseline are from **0.8.11**, the last published version recorded in this repository. Source **0.8.12** remains unreleased. This folder is not a live store-status report; match draft text to the package selected for a future submission.

Maintainer instructions default to English. The listing remains Chinese for the product's primary market, with Chinese counterparts for the maintainer guides.

## Materials

| Material | Location |
| --- | --- |
| User-facing listing copy | [Chinese listing](zh-CN/listing.md) |
| Privacy-form guidance | [English](privacy-disclosure.md) / [中文](zh-CN/privacy-disclosure.md) |
| Reviewer notes | [English](reviewer-instructions.md) / [中文](zh-CN/reviewer-instructions.md) |
| Public privacy policy | [extension-tracker/PRIVACY.md](../extension-tracker/PRIVACY.md) |
| Recorded native-browser acceptance | [acceptance-0.8.11.json](acceptance-0.8.11.json) |
| Runtime icons | [icons/](../extension-tracker/icons/) — 16, 32, 48, and 128 px |
| Promotional image | [small-promo.png](assets/small-promo.png) — 440 × 280 |
| Synthetic screenshots | [Overview](assets/screenshot-overview.png), [no changes](assets/screenshot-no-changes.png) — 1280 × 800 |

Screenshots show synthetic records in the actual extension, marked “合成演示数据”. They retain the baseline interface rather than depicting the unreleased UI. Artwork contains no real job-search records. The separate [offline demo](../examples/index.html) explains account and export behavior; it is not a chat browser built into the extension.

The recorded acceptance used isolated profiles and synthetic accounts for encryption and restart persistence. It does not establish current website compatibility or two-real-account switching. See [verification](../docs/VERIFICATION.md) for the real-platform scope.

## Preparing a submission

The account owner confirms dashboard contact and identity information, required declarations, distribution settings, and category. Keep ordinary account credentials and real chat exports out of reviewer materials.

Use the stable [public privacy-policy URL](https://github.com/L1pp/boss-chat-recorder/blob/main/extension-tracker/PRIVACY.md), and check that it is accessible without login and matches the submitted package. Project home: [GitHub](https://github.com/L1pp/boss-chat-recorder). Support: [Issues](https://github.com/L1pp/boss-chat-recorder/issues).

Follow [releasing](../docs/RELEASING.md) for packaging and authorized store operations. Runtime ZIPs contain only runtime files, with manifest.json at the root. Check Google's [package](https://developer.chrome.com/docs/webstore/prepare) and [artwork](https://developer.chrome.com/docs/webstore/images) requirements before submission.
