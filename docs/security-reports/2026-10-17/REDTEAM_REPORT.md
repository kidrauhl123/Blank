# 红队测试、复现步骤与证据说明

日期：2026-10-17。范围为本地模拟 BankPilot，基线 `aa1b8d874641e996af403b553a605d297ae49eed`。测试明确排除真实账户、真实资金、线上服务扫描、付费模型攻击、真实社交渠道和第三方目标。

## 授权与环境

用户授权审查团队私有仓库并在独立分支最小修复；独立成果只发布到 `sikonglei/bankpilot-security` 私有仓库。测试使用新建本机数据库 `bankpilot_security_test`，数据库角色 `bankpilot_test`；连接只监听 127.0.0.1。模拟身份以随机 UUID 创建。测试秘密只在本机环境使用，不进入本仓库证据。

环境为 Windows x64、Node 24.19.0、PostgreSQL 17.6、Vitest 4.1.11、Next.js 16.3.8。数据库二进制来自 npm `@embedded-postgres/windows-x64@17.6.0-beta.15`，应用依赖来自原项目锁文件的本地转换；转换锁文件没有提交。二进制包仅用于本地测试，不随成果分发。来源：[embedded-postgres 官方项目](https://github.com/leinelissen/embedded-postgres)。Linux CI 配置已提供，但其执行状态必须单独记录。

## 攻击与判据

| ID | 动作与观察 | 修复前 | 最终结果 |
|---|---|---|---|
| RT-01 | 草稿 prepared_at 改为 11 分钟前，提交；要求 AUTH_EXPIRED 且零账本 | 意外成功，测试失败 | 拒绝，通过 |
| RT-02 | 在测试库把已准备金额加 1 分，提交；要求对象不符且零账本 | 意外成功，测试失败 | 拒绝，通过 |
| RT-03 | 替换草稿收款账户及关联客户，提交；要求对象不符且零账本 | 意外成功，测试失败 | 拒绝，通过 |
| RT-04 | 同一有效 TOTP 提交两笔 1,100 元红色草稿 | 第二笔也成功，测试失败 | 第二笔拒绝，通过 |
| RT-05 | 两笔红色草稿并发携带同一 TOTP | 两笔都成功，测试失败 | 仅一笔成功，通过 |
| RT-06 | 收款客户尝试提交付款客户的操作编号 | 拒绝，通过 | 拒绝，通过 |
| RT-07 | 重复提交同一成功操作 | 仅一笔分录，通过 | 返回原回执，仍仅一笔，通过 |
| RT-08 | 故障注入重复账本 reference，强制事务回滚，再重试 | 未运行（非前后对照） | 回滚时 TOTP 不消耗，恢复后可正常过账，通过 |
| RT-09 | 未配置验证器的客户连续提交三个六位无效码 | 未运行（非前后对照） | 第三次锁定，后续拒绝，零过账，通过 |

RT-01～03 通过测试库故障注入构造状态，不证明外部攻击者具备改库权限。RT-04/05 前提是有效会话和已知有效码；没有演示绕过 TOTP 计算。RT-08 的故障是受控数据库唯一约束冲突，未破坏任何真实交易。

HTTP-01～08 验证未登录 bootstrap/账单读取、缺少或伪造 Origin、带无效 Bearer、未认证 Agent 请求。保留预期和实际状态码、错误码及响应 SHA-256；不保留响应正文。结果 8/8 通过。它证明这些具体请求被拒绝，不证明全部 API 的授权没有缺陷。

## 复现

在原私有项目修复分支上，使用 Node 24、PostgreSQL 17，先创建全新的本机专用数据库与角色。不可用生产连接运行测试。按序应用 `db/migrations/*.sql`；历史迁移包含 TRUNCATE，仅允许对全新隔离库初始化。已部署库只能应用迁移表中未执行的新迁移。

安装原项目锁定依赖：`npm ci --ignore-scripts`。设置 `DATABASE_URL` 指向 127.0.0.1、`bankpilot_test`、`bankpilot_security_test`，并设置仅测试用 `PASSWORD_PEPPER`。源码 PR 中的测试有主机、用户和库名校验；这不是对恶意运维配置的绝对隔离。

运行单组：

```text
BANKPILOT_SECURITY_TESTS=1 npm test -- src/lib/security-redteam.integration.test.ts
```

运行全部（上述环境变量语法为 POSIX；PowerShell 请通过 $env: 设置）：

```text
BANKPILOT_DB_TESTS=1 BANKPILOT_SECURITY_TESTS=1 npm test -- --no-file-parallelism
npx next typegen
npx tsc --noEmit
npm run lint
```

测试会保留本次新建模拟身份用于本机复核；测试结束后停止并丢弃整个专用实例。不要对共享演示库运行后再手工按宽泛条件删除数据。CI 的 PostgreSQL 服务为一次性隔离库。

HTTP 探针使用 Python 标准库，没有第三方依赖。先在正确测试数据库配置下启动只监听本机的应用，不填真实模型密钥，然后运行：

```text
python tools/http_boundary_probe.py --base-url http://127.0.0.1:3017 --output work/http-boundary.json
```

探针只允许显式 127.0.0.1 HTTP 目标，禁用代理与重定向，不登录，不做已认证修改。每条请求有超时。代码本身不能将目标扩展到公网或远程内网。

修复前对照可在基线 SHA 的单独临时检出中仅放入 RT-01～07 测试运行；RT-08 依赖新迁移，不应直接放入原版。不得为展示“通过”而删除原始失败结果。

## 模型红队计划（本轮未执行）

`corpus/prompt-injection.jsonl` 是本次原创的 12 条场景。每条均为 NOT_RUN，没有模型抵抗率。覆盖直接/间接注入、角色冒充、确认伪造、验证码索取、数据外发、虚假回执、跨客户引用、拆分绕限和危险工具请求。

后续先在独立模拟环境适配 promptfoo 或 PyRIT，再记录模型精确版本、参数、攻击轮次与测试账户授权。判据必须同时检查工具轨迹、是否触发人工交接、数据库是否过账/越权、是否泄漏数据和回答是否与银行事实一致；单句“拒绝”或 LLM judge 分数不足以证明安全。多次重复测试以记录随机性，并人工复核判定分歧。

## 证据文件与限制

`vitest-baseline.json`、`redteam-before.json`、`redteam-after-seven.json`、`vitest-final.json` 均为真实 Vitest 输出的脱敏摘要；原始输出的 SHA-256 也保留。只截取用例标题/状态/时间，失败信息仅标记是否存在，不包含源码堆栈。HTTP 证据为真实请求结果，`verification.json` 记录静态检查。`provenance.json` 记录基线和已测文件哈希。

`SHA256SUMS.txt` 用于交付包完整性核对，不是数字签名。原始本机日志保留在工作区，不复制到个人成果仓库。文件发布、源码 PR 与 CI 的链接在 README 中记录；若远端 CI 尚未完成，应写“待执行/待确认”，不得把本地结果冒充远端结果。
