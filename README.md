# Trawler - Web Crawler API Service

面向大模型知识库的网页爬取API服务。

## 项目概述

Trawler 是一个支持静态/动态网页爬取、递归爬取、内容筛选的异步爬虫服务，为大模型知识库提供高质量的HTML内容采集能力。

## 核心特性

- 🚀 异步任务处理 - 支持批量URL爬取
- 🎭 统一处理 - 使用Playwright自动处理静态和动态网页
- 🔄 递归爬取 - 可配置深度、URL模式匹配
- 🎯 内容筛选 - CSS选择器提取、移除无关元素
- 🔐 认证支持 - Cookie/Header/Basic Auth
- 🛡️ 反爬虫对抗 - 代理轮换、浏览器指纹伪装
- 📊 监控指标 - 任务统计、队列状态、存储使用情况
- ☸️ 云原生 - K8s StatefulSet部署，高可用架构

## 技术栈

- **运行时**: Node.js + TypeScript
- **API框架**: Fastify
- **爬虫引擎**: Crawlee + Playwright
- **任务队列**: BullMQ + Redis
- **数据库**: MongoDB
- **部署**: Kubernetes StatefulSet

## 项目状态

🚧 设计阶段 - 详细设计文档见 [docs/plans/2026-02-12-web-crawler-api-design.md](./docs/plans/2026-02-12-web-crawler-api-design.md)

## 快速开始

> 项目尚未实现，敬请期待

## 文档

- [设计文档](./docs/plans/2026-02-12-web-crawler-api-design.md) - 完整的架构设计和技术方案

## License

TODO
