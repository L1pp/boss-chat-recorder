# 文档导航

[English](../README.md) | [简体中文](README.md) · [项目概览](../../README_CN.md)

| 内容 | 文档 |
| --- | --- |
| 安装、采集、导出与常见问题 | [使用指南](USAGE.md) |
| 组件、账号隔离与本地存储 | [技术架构](ARCHITECTURE.md) |
| 构建、测试与合成样例 | [测试说明](TESTING.md) |
| Actions 打包与商店操作 | [发布流程](RELEASING.md) |
| 配置可选的自动审阅服务 | [AI 审阅](AI_REVIEW.md) |
| 历史验证结果与范围 | [验证记录](VERIFICATION.md) |
| 版本沿革 | [更新记录](CHANGELOG.md) |
| 代码来源与许可 | [来源说明](PROVENANCE.md) |
| 提交问题和 PR | [参与贡献](CONTRIBUTING.md) |
| 私下报告漏洞 | [安全报告](SECURITY.md) |
| 数据处理方式 | [隐私政策](../../extension-tracker/PRIVACY.md) |

## 目录职责

| 目录 | 用途 |
| --- | --- |
| `extension-tracker/` | 可加载扩展及生成的采集脚本 |
| `scripts/` | 采集源码、构建、测试和发布辅助程序 |
| `tests/` | 离线及合成 Chromium 回归 |
| `examples/` | 合成 JSON 和离线预览 |
| `store/` | 商店文案、图片、披露和审核材料 |
| `.github/` | 社区规范、问题与 PR 模板、Actions |
| `docs/zh-CN/` | 与英文主题对应的中文指南 |

根目录保留项目概览、许可证、Agent 指引及工具必要配置。具体操作集中在对应指南中，不再重复堆放到 README。
