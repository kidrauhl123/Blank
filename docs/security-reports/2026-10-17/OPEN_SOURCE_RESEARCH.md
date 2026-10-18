# AI Agent / LLM 红队工具与许可证选型

核验日期：2026-10-17（Asia/Shanghai）。只使用项目官方仓库、README 与许可证作为选型依据。以下项目为研究对象，本轮未安装运行其模型扫描功能，不能据此给出扫描通过率。

| 项目 | 核验版本（提交） | 许可证 | 对 BankPilot 的用途与边界 |
|---|---|---|---|
| [promptfoo](https://github.com/promptfoo/promptfoo) | `8398ca76d5a6b0b7b7495edd8561b2fcdea66eb5` | MIT | 首选后续声明式提示词回归及 CI 配置。须先适配有会话、页面动作和人工确认的应用协议，不能把模型文本拒绝当成资金安全。 |
| [Microsoft PyRIT](https://github.com/Azure/PyRIT) | `bec7cb5d6089481d75fb8df143793de3da6905f5` | MIT | 适合多轮、可编程对抗流程及攻击变换。需要测试目标、模型及评分器配置；测试日志可能含敏感上下文。 |
| [NVIDIA garak](https://github.com/NVIDIA/garak) | `1b54bb8a51ffce547e56df22ba73a0abbaa56982` | Apache-2.0 | 适合模型输出、注入和泄漏探测；可扩展目标接口。模型扫描结果不能证明客户隔离、交易幂等或账本一致性。 |
| [DeepTeam](https://github.com/confident-ai/deepteam) | `d76a51df3b56ef186d81bd847008946d8656ab1c` | Apache-2.0 | 可作为应用级对抗评估的备选。需按银行动作增加结果判据，并人工复核自动评分。 |

许可证原文：[promptfoo MIT](https://github.com/promptfoo/promptfoo/blob/8398ca76d5a6b0b7b7495edd8561b2fcdea66eb5/LICENSE)、[PyRIT MIT](https://github.com/Azure/PyRIT/blob/bec7cb5d6089481d75fb8df143793de3da6905f5/LICENSE)、[garak Apache-2.0](https://github.com/NVIDIA/garak/blob/1b54bb8a51ffce547e56df22ba73a0abbaa56982/LICENSE)、[DeepTeam Apache-2.0](https://github.com/confident-ai/deepteam/blob/d76a51df3b56ef186d81bd847008946d8656ab1c/LICENSE.md)。以上标识通过 GitHub 仓库元数据核验，并阅读相应许可证。

复用 MIT 代码时保留版权和许可文本；复用 Apache-2.0 代码时附许可证、保留相关声明，标明改动，并按上游 NOTICE 要求处理署名。安装包依赖、数据集、模型权重、外部服务和商业附加功能需分别核验，不自动继承框架许可证。本轮未复制这些项目的实现或攻击数据集，也未改变团队源码的许可。

本轮选择“现有 Vitest + 真实 PostgreSQL 事务回归 + 独立 Python HTTP 探针”：它直接验证已识别的业务授权缺口，保持应用依赖不变。新增的对抗语料为本次编写，保留为待执行的模型测试计划。未来接入上述框架时应固定版本，关闭不必要遥测，不把团队源码、账户数据或密钥提交到在线共享/托管评测服务。

风险分类参考 [OWASP LLM 应用 Top 10](https://owasp.org/projects/top-10-for-large-language-model-applications)。该分类用于检查覆盖面，不代表获得 OWASP 认证。
