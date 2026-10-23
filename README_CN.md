# BOSS 沟通记录本地助手

[English](README.md) | [简体中文](README_CN.md)

[![Automated tests](https://github.com/L1pp/boss-chat-recorder/actions/workflows/ci.yml/badge.svg)](https://github.com/L1pp/boss-chat-recorder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

非官方浏览器扩展：在本机保存自己的 BOSS 沟通记录，增量更新变化会话，并导出 JSON 供自行整理和分析。

## 主要功能

- 手动采集当前账号可获取的会话和聊天历史。
- 更新新增、变化或尚未完成的会话，中断后可继续。
- 按账号分别归档，新写入的归档数据在本机加密。
- 导出全部记录、本次更新涉及的会话或账号备份。
- 支持中英文界面，并记住手动选择。

扩展不发送消息、不投递简历，不向开发者或 AI 服务上传聊天。导出的 JSON 为明文，请自行保管。详见[隐私政策](extension-tracker/PRIVACY.md)。

## 开始使用

1. 从 [Chrome Web Store](https://chromewebstore.google.com/detail/phaihpchfdihnclgjhpmpnhobdcogdhb) 安装，或按[使用指南](docs/zh-CN/USAGE.md)从源码加载。
2. 正常登录自己的账号，打开 [BOSS 沟通页](https://www.zhipin.com/web/geek/chat)。
3. 打开扩展开始采集，保留沟通页，之后按需更新或导出。

只能保存网站当前提供的历史；遇到人工验证时，请先在网页完成验证，再继续采集。

## 文档与帮助

[使用指南](docs/zh-CN/USAGE.md) · [文档导航](docs/zh-CN/README.md) · [参与贡献](docs/zh-CN/CONTRIBUTING.md) · [安全报告](docs/zh-CN/SECURITY.md) · [问题反馈](https://github.com/L1pp/boss-chat-recorder/issues)

欢迎中文反馈和贡献。本项目与 BOSS 直聘无隶属、授权或背书关系。

使用 [MIT License](LICENSE)。
