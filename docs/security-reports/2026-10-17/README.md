# Blank（原 BankPilot）完整安全报告与测试证据

**历史快照**：本目录是 2026-10-17 评测的记录，正文和证据不随后续开发改动。当前的安全状态见 [安全设计与自评](../../SECURITY.md)；2026-11-01 的提示词注入回归见 [../2026-11-01/prompt-injection-regression.md](../2026-11-01/prompt-injection-regression.md)。

本目录于 2026-10-18 经用户授权同步到团队私有仓库，供 PR #2 审阅。报告评估日期仍为 2026-10-17；本次同步不改变既有测试结果，不代表已合并或部署。

## 正式报告

| 材料 | 在线阅读 | 可编辑 Word |
|---|---|---|
| 安全设计文档 | [Markdown](SECURITY_DESIGN.md) | [下载 DOCX](word/BankPilot_安全设计文档.docx) |
| 安全自评报告 | [Markdown](SECURITY_SELF_ASSESSMENT.md) | [下载 DOCX](word/BankPilot_安全自评报告.docx) |
| 红队测试与证据报告 | [Markdown](REDTEAM_REPORT.md) | [下载 DOCX](word/BankPilot_红队测试与证据报告.docx) |
| 开源工具与许可证研究 | [Markdown](OPEN_SOURCE_RESEARCH.md) | — |

## 与当前分支的对应关系

原评估基线为 `aa1b8d874641e996af403b553a605d297ae49eed`，原测试修复提交为 `a1b5d99cd5856214a94d0d5eff6de696cc51e896`。本次以已有提交 `a207c26a987dbcdf3cd7df29d8e79f62e284e4bb` 为父提交，仅补充报告和文档入口，保留其他人的源码与迁移更新。

当前待部署迁移是 **`db/migrations/018_totp_replay_protection.sql`**，原编号为 015；报告和安全设计 Word 同步副本已更新文件名。历史测试记录、原提交和哈希保持原样，不把旧测试冒称当前所有分支合并后的重新验收。与其他分支集成时须保留其 015、016、017 映射。已有数据库只执行未应用迁移，不重跑破坏性初始化。

Word 文件沿用当前本地保存版本；原文件未覆盖，安全设计副本仅更正两处迁移文件名。修正详情与文件摘要见 [同步记录](evidence/team-sync.json)。Markdown 为在线阅读版本，Word 为可编辑提交材料。

## 证据与复现

- [测试证据索引](evidence/README.md)：原版无数据库基线、修复前后结果、完整回归、HTTP 探针及历史 GitHub CI。
- [红队测试复现说明](REDTEAM_REPORT.md)：本地模拟环境、利用前提与测试限制。
- [独立本机 HTTP 探针](tools/http_boundary_probe.py)和[Vitest 脱敏摘要工具](tools/summarize_vitest.py)。工具路径相对于本目录，运行示例应在本目录执行。
- [原创模型红队语料](corpus/prompt-injection.jsonl)：12 条全部 NOT_RUN。
- `SHA256SUMS.txt`：本次完整同步内容的 SHA-256，可核对文件完整性，不是数字签名。

本地完整回归 181/181 与 HTTP 边界 8/8 为原轮次实际结果。真实模型红队、生产部署和真实渠道 E2E 仍未执行，剩余风险保留于自评报告。

本目录只包含报告、独立工具与脱敏证据，不含真实账户、会话、TOTP 秘密或模型密钥。仓库保持 Private，不改变协作者权限；不复制个人私有仓库中无关文件。
