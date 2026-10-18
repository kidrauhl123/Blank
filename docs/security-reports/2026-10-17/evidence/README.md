# 证据索引

这些文件来自实际执行，不是预填的通过结果。所有时间字段使用 UTC；评估日期及人类可读文档使用 Asia/Shanghai。

| 文件 | 内容 |
|---|---|
| vitest-baseline.json | 上游无数据库基线：133 通过、39 跳过 |
| redteam-before.json | 修复前 RT-01～07：2 通过、5 失败 |
| redteam-after-seven.json | 第一轮修复后同组七项全部通过 |
| vitest-final.json | 数据库开关开启后的全部 181 项结果（含 RT-01～09） |
| http-boundary.json | 八次真实本机 HTTP 请求的状态、错误码和响应摘要 |
| verification.json | 类型、代码规范检查和模型红队执行状态 |
| provenance.json | 代码基线、环境及本地已测文件摘要 |
| open-source-sources.json | 四个研究项目的提交及许可证标识 |
| github-ci.json | GitHub 远端成功运行的提交、时间和步骤状态 |
| publication.json | 两个草稿 PR、私有可见性及原项目 main 未修改核验 |

Vitest 摘要只保留用例标题、状态、耗时及是否有失败记录。原始文件摘要用于核对本机留存原始输出，原始日志不在本仓库。没有堆栈、源码片段、绝对用户路径、会话、验证码、模型密钥、账户标识或完整响应正文。

PASS/passed 表示对应具体断言通过；FAIL/failed 表示该断言失败；skipped/NOT_RUN 不能计入通过率。RT-08/09 没有修复前结果。真实模型 12 条用例全部未运行，不能从替身测试推导模型抵抗率。

完整性校验列于仓库根目录 SHA256SUMS.txt；摘要不提供身份签名或独立审计认证。
