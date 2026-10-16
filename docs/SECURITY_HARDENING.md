# 2026-10-17 转账授权加固

基线 `aa1b8d874641e996af403b553a605d297ae49eed`。本次仅修复三类已复现授权缺口，不改变业务阈值，也不增加应用依赖。

- 全部转账草稿十分钟有效，执行时在锁等待之后按数据库时钟判定；风险升级不刷新绝对期限。
- 比对准备时已有的授权指纹，并检查收款账户所属客户。测试库篡改是内部状态故障注入，不代表已找到普通 HTTP 用户可改库的攻击链。
- 交易 TOTP 原子消费时间步，与过账同事务提交/回滚。高风险第二笔需新时间步；同一操作成功后重试仍返回原回执。

先应用新迁移 `015_totp_replay_protection.sql`，再部署应用。已有数据库只执行未应用迁移；不得重跑含 TRUNCATE 的旧初始化脚本。生产 compose 同时覆盖了新数据库的初始化映射。回滚代码时保留计数列；回滚会取消防重放保护。

新增测试：`src/lib/security-redteam.integration.test.ts`。测试仅允许 127.0.0.1、bankpilot_test 角色、bankpilot_security_test 数据库。使用独立一次性实例；测试会留存模拟身份供核验。用测试专用 PASSWORD_PEPPER，设置 BANKPILOT_SECURITY_TESTS=1；全部数据库测试再设置 BANKPILOT_DB_TESTS=1，运行 `npm test -- --no-file-parallelism`。新工作流在隔离 PostgreSQL 服务运行相同检查，远端实际结果需单独确认。

本地证据：原有无 DB 基线 133 通过/39 跳过；新增 RT-01～07 修复前 2 通过/5 失败，首轮修复后 7 通过；新增 RT-08/09 后全套 181 通过、0 失败、0 跳过。TypeScript、ESLint 和八项本机 HTTP 边界探针通过。RT-08 验证账本失败时消费状态回滚，RT-09 验证单挑战熔断。

真实模型注入/幻觉、多轮红队、真实渠道 E2E、完整依赖审计和部署复测本轮未做。跨草稿总失败熔断、绑定防重放、客户端所见内容签名绑定、独立审计存储仍待完善。

正式《安全设计文档》《安全自评报告》、开源工具选型、原创待执行语料、独立 HTTP 探针和脱敏证据位于获用户授权的私有仓库 [sikonglei/bankpilot-security](https://github.com/sikonglei/bankpilot-security)。该库没有复制团队应用源码；访问权限由仓库所有者与团队确认。
