# CONTABO-jp 部署

本文记录的是 CONTABO-jp 线上部署。想在自己的电脑上运行一份，请看 [本地部署](LOCAL_DEPLOYMENT.md)。

## 拓扑

- 代码目录：`/opt/bankpilot`
- Compose：`deploy/compose.production.yml`
- 应用容器：`bankpilot-app`，512 MB / 1 CPU
- PostgreSQL：`bankpilot-postgres`，512 MB / 0.75 CPU
- 企业微信适配器：可选 profile，`bankpilot-wecom`，256 MB / 0.5 CPU
- QQ 适配器：可选 profile，`bankpilot-qq`，256 MB / 0.5 CPU
- 数据卷：`bankpilot_postgres`
- 边缘代理：现有 Caddy，经 `premsir-chat_backend` 网络访问应用
- 数据库：只在 `bankpilot_internal` 内部网络可达，不发布主机端口

该资源配额适合 4–5 人的比赛测试。生产域名应放在 Cloudflare 代理或 Tunnel 后，公开仓库不记录源站 IP。

## 定时任务服务

应用迁移 `020_scheduled_tasks.sql` 后，配置私有 `SCHEDULER_TOKEN`（至少 32 字符），同时启动 `app scheduler`。自动部署脚本会处理首次凭据生成与服务启动；手动部署须自行设置。任务页通过心跳显示调度服务是否就绪。详见 [定时任务](SCHEDULED_TASKS.md)。

## 首次配置

```bash
cp deploy/.env.production.example deploy/.env.production
openssl rand -hex 32   # 写入 POSTGRES_PASSWORD
openssl rand -hex 32   # 写入 PASSWORD_PEPPER；部署后不得随意更换
```

AI 变量为空时，银行基础功能正常工作，内置助手明确显示未配置且不会输出替代回复。访客可以在设置页填写自己的模型接口，密钥用 `PASSWORD_PEPPER` 派生的密钥加密保存（迁移 `045_visitor_model_keys.sql`），因此运营方的 `AI_API_KEY` 不是必需的；代价是后台任务（动态的文字撰写、每日巡检的主模型、IM 渠道）没有访客上下文，只能使用运营方配置。模型名单可用 `AI_ALLOWED_MODELS` 限定，模板里默认填入示例名单；设置页只显示这份名单与上游目录的交集。见 [模型设置](MODEL_SETTINGS.md)。

必须设置 `BANKPILOT_PUBLIC_URL` 为用户实际访问的 HTTPS 域名。机器人变量在取得平台凭据前可留空，此时不要启用对应 profile。

## 发布

模拟理财及五位用户历史需要先依次应用 `021_simulated_investments.sql`、`022_demo_investment_history.sql` 再启动新版 APP，否则新增的账户资产汇总和模拟身份登录无法读取。Compose 新安装及发布检查已纳入两项迁移；实现与验证边界见 [模拟理财](SIMULATED_INVESTMENTS.md)。2026-10-25 已发布，见下方记录。

每日 AI 巡检还需要 `023_daily_ai_reviews.sql`、APP 私有环境中的 `TYPESAFE_API_KEY` 及现有主模型配置，迁移后重建 APP 并启动 scheduler。密钥不进入 Git 或源码同步；自动发布会在远端备份完成后，将本地私有配置中指定的 Jev 变量通过 SSH 标准输入安装到远端私有环境文件。2026-10-25 已发布，见 [每日巡检](DAILY_AI_REVIEWS.md)。


含授权补强的版本必须应用 `019_authorization_hardening.sql` 后启动新版。迁移会取消升级前未完成的转账草稿及对应挑战/任务，保留资金和历史回执；已有 TOTP 用户可能需等待最多约 60 秒使用新的动态码。先在隔离 PostgreSQL 上通过全部回归，细节见 [授权补强与验证范围](AUTHORIZATION_HARDENING.md)。

2026-11-01 的各次发布应用了迁移 033 至 044（立规矩、当场造工具、反诈守护、首页动态检查、生活记忆、网点与换汇预约、预算提醒、自定义做法、新设备、赞踩记录、Blank 互联）。每个迁移对应的提交见下方发布记录。`scripts/deploy.sh` 的发布后核对目前只检查到 `032_ui_layout.sql`，但 `migrate.sh` 会执行所有尚未应用的迁移。发布后请核对，应看到最后 12 条是 033 至 044：

```bash
ssh CONTABO-jp 'docker exec bankpilot-postgres psql -U bankpilot -d bankpilot -Atc "SELECT version FROM schema_migrations ORDER BY version" | tail -n 12'
```

已配置服务器上的私有环境文件后，推荐在可访问部署服务器的本机执行：

```bash
bash scripts/deploy.sh CONTABO-jp
```

脚本要求本地改动已提交，只同步当前提交的源码；先备份远端数据库、环境和代码，再构建、停用旧运行时、应用迁移、启动并核对账本不变量、LangGraph 健康与旧接口删除。失败时停止并输出备份路径，不自动恢复数据库。成功后将发布提交写入远端 `DEPLOYED_COMMIT`。首次配置环境及真实机器人平台联调仍按本文步骤完成。

上面的 `CONTABO-jp` 是示例别名。请在本机 `~/.ssh/config` 里配置实际主机，脚本参数就是这个别名。

部署脚本的 SSH 超时会返回 255，即使远端已经部署。判定是否成功，要看脚本输出的 `Deployed <提交>`，并核对远端 `/opt/bankpilot/DEPLOYED_COMMIT` 等于要发布的提交；只看退出码不够。

本地 `.env.local` 中有 `TYPESAFE_API_KEY` 时，`configure-jev-remote.mjs` 在备份后仅同步 `TYPESAFE_API_KEY`、可选的 `TYPESAFE_MODEL`、`JEV_TIMEOUT_MS` 和 `JEV_QUIET_THRESHOLD`；不覆盖服务器数据库、主模型或渠道配置，密钥不出现在命令参数或日志中，远端环境文件权限为 600。没有本地 Key 时保留服务器现有设置。手动发布不执行此辅助步骤，需自行配置远端私有变量。

以下为手动发布步骤。

本机同步代码：

```bash
rsync -az \
  --delete \
  --exclude node_modules \
  --exclude .next \
  --exclude .env \
  --exclude .env.local \
  --exclude .env.production \
  --exclude deploy/.env.production \
  --exclude backups \
  --exclude releases \
  --exclude DEPLOYED_COMMIT \
  --exclude .playwright-cli \
  ./ CONTABO-jp:/opt/bankpilot/
```

服务器先启动数据库、执行尚未应用的迁移，再构建应用：

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d postgres --wait && \
  bash scripts/migrate.sh --env-file deploy/.env.production -f deploy/compose.production.yml && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d --build app --wait'
```

取得企业微信机器人凭据后单独启用渠道 Worker：

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml \
  --profile wecom up -d --build wecom'
```

取得 QQ 机器人 AppID 与 AppSecret 后启用 QQ Worker：

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml \
  --profile qq up -d --build qq'
```

迁移表 `schema_migrations` 保证 SQL 每版只执行一次。旧原型第一次应用 `002_identity_and_platform.sql` 时会删除旧版预置业务数据；之后绝不会因再次部署而重跑。

### 从旧的双运行时部署升级

同步时的 `--delete` 会移除服务器上已经退役的源码；私有环境文件、依赖与 `backups` 目录在排除列表中。首次升级前，按下方“备份与恢复”备份数据库，并停止旧运行时容器，避免旧进程继续创建草稿：

```bash
docker rm -f bankpilot-nanobot
```

按上述发布命令执行 `009_retire_legacy_agent.sql`，再重建应用。该迁移先撤销旧运行时签发的 API 令牌及客户端，再删除四张专用表；银行账户、转账草稿、账本、审计和 LangGraph checkpoint 保留。新安装不再创建退役表，迁移对不存在的表会直接跳过。

升级后，从服务器私有环境文件删除旧 `NANOBOT_*` 变量，并删除旧的凭据/会话数据卷：

```bash
docker volume rm bankpilot_nanobot
```

旧个人微信连接及用户自建机器人绑定不会迁移到官方渠道。QQ、企业微信使用现有官方 Worker，用户在 `/channels` 重新走银行账户绑定流程。

### 从外部工具平台升级

新版删除对外 MCP、OpenAPI、开发者中心和客户令牌接口。发布前备份，停止旧应用后执行 `013_retire_external_access.sql`：撤销全部旧客户凭据，将客户端和令牌改名归档，调用记录迁入 `external_access_history`；银行数据与会话不清空。未完成的历史 MCP 任务取消、线程关闭，新增此类渠道被拒绝。详见 [外部接入退役](EXTERNAL_ACCESS_RETIREMENT.md)。

从服务器环境中删除 `MCP_ALLOWED_ORIGINS`；自动发布脚本会处理该项。QQ/企微内部适配令牌及模型服务密钥继续使用，不属于被退役的客户令牌。发布验收检查 013、归档凭据撤销、旧地址 404 和银行 APP 拒绝 Authorization 头。

## 发布记录

| 日期 | 提交 | 迁移 | 结果 |
| --- | --- | --- | --- |
| 2026-10-19 | `2a56ca3` | 到 `020_scheduled_tasks.sql`（9 项必需迁移到位） | 发布标记 `20261019T084641Z`；备份 `/opt/bankpilot/backups/release-20261019T084641Z/`（dump、env、source，权限 600）；`/api/health` 正常，账本不变量通过，退役表与退役路由不存在，`Authorization` 头返回 403，调度心跳正常；`https://bank.jung.edu.pl` 返回 200 且 TLS/安全响应头正常 |
| 2026-10-19 | `f3f0690`（手机画布 UI、文档状态校正、付款人锁用例修复） | 无新增迁移，全部为 `skip` | 发布标记 `20261019T170551Z`；备份 `/opt/bankpilot/backups/release-20261019T170551Z/`；账本不变量通过，`/api/health` 为 `{"status":"ok","database":"connected","agentRuntime":"ready","ai":{"configured":true}}`，应用与调度容器健康；线上八个产品路由均 200、三个退役路由 404；`.env` 模板文件已随源码同步（校验和一致）。此前 `0e3e705` 已同流程发布，仅源码与文档不同 |
| 2026-10-20 | `e28c1ad`（画布内圆形触点，去掉系统指针与其余桌面形态） | 无新增迁移，全部为 `skip` | 发布标记 `20261020T044113Z`；备份 `/opt/bankpilot/backups/release-20261020T044113Z/`；`DEPLOYED_COMMIT` 为 `e28c1ad`，`bankpilot-app`、`bankpilot-scheduler`、`bankpilot-postgres` 均健康，账本不变量通过；`/api/health` 为 `{"status":"ok","database":"connected","ai":{"configured":true,"model":"deepseek-v4.1-flash-free"},"agentRuntime":"ready","channels":{"wecomInternalApi":true,"qqInternalApi":false}}`；线上八个产品路由 200、三个退役路由 404；线上画布已确认 `cursor: none`、圆形触点 30px、按下收缩到 20.4px 且圆心不动 |
| 2026-10-25 | `3b46529`（模拟理财、整页助手、Jev 每日巡检及录制支持） | 确认 `021`–`024` 已应用，本次迁移命令均为 `skip` | 发布标记 `20261025T042257Z`；备份 `/opt/bankpilot/backups/release-20261025T042257Z/`（dump、env、source 均为 600）；`DEPLOYED_COMMIT` 与运行时提交一致；APP 与 PostgreSQL 健康，scheduler 运行且心跳新鲜，账本不变量通过。公开首页及健康接口 200；逐一登录五位用户，均读取到六只产品、两笔当前持仓、四笔预置理财回执及四笔关联账户明细，退出会话成功。首页巡检功能已启用，Jev 和主模型配置存在；从 APP 容器对 Jev 作无客户数据的真实请求，HTTP 200，响应 `jev-1.13.0`、概率 0.1、耗时 498ms。未运行申赎、完整巡检任务、外部通知或视频录制；后续文档提交不改变此运行时版本。 |
| 2026-11-01 | `fbadd07` | `033_wallet_rules.sql` | 立规矩（P0-1）。发布标记 `20261101T023420Z`；备份 `/opt/bankpilot/backups/release-20261101T023420Z/`；DEPLOY_EXIT=0；已核对健康检查与 `DEPLOYED_COMMIT` |
| 2026-11-01 | `7e41975` | `034_interactive_tools.sql` | 当场造工具（P0-2）。部署日志在 SSH 超时后返回 255，发布后经远端 `DEPLOYED_COMMIT` 核对（见上文“SSH 超时”） |
| 2026-11-01 | `79671d9` | `035_fraud_guard.sql` | 反诈守护（P0-3）。发布标记 `20261101T035425Z`；DEPLOY_EXIT=0；已核对健康检查与 `DEPLOYED_COMMIT` |
| 2026-11-01 | `9667985` | `036_feed_check_requests.sql` | 首页动态：事件检查与每小时心跳（P0-4）。发布标记 `20261101T042803Z`；DEPLOY_EXIT=0；已核对健康检查与 `DEPLOYED_COMMIT` |
| 2026-11-01 | `f93898a` | `037_life_memories.sql` | 生活记忆（P0-5）。发布标记 `20261101T050122Z`；DEPLOY_EXIT=0；已核对健康检查与 `DEPLOYED_COMMIT` |
| 2026-11-01 | `7f7eaa9` | `038_bank_reservations.sql`、`039_budget_alerts.sql`、`040_custom_skills.sql` | Skills 库、网点与换汇预约、预算提醒、自定义做法（P0-6）。发布标记 `20261101T072404Z`；DEPLOY_EXIT=0；已核对健康检查与 `DEPLOYED_COMMIT` |
| 2026-11-01 | `0130050` | `041_feed_immediate_checks.sql`、`042_new_device_guard.sql`、`043_feed_reactions.sql` | P0 遗留补全：动态即时检查、新设备判断、赞踩记录。发布标记 `20261101T080623Z`；DEPLOY_EXIT=0；已核对健康检查与 `DEPLOYED_COMMIT` |
| 2026-11-01 | `4ac390c` | `044_blank_link.sql` | Blank 互联（P0-7）。发布标记 `20261101T083130Z`；DEPLOY_EXIT=0；已核对健康检查与 `DEPLOYED_COMMIT` |
| 2026-11-01 | `7bc3fd9` | 无 | IM 回 App 继续（P1）。发布标记 `20261101T102838Z`；DEPLOY_EXIT=0；已核对健康检查与 `DEPLOYED_COMMIT` |
| 2026-11-01 | `987ce89` | 无 | 提示词注入防护补课（P1）。发布标记 `20261101T104855Z`；DEPLOY_EXIT=0；已核对健康检查与 `DEPLOYED_COMMIT` |
| 2026-11-01 | `d7f704d` | 无 | 交易风险信号改由服务端提供，聊天转账带上新设备标记，移除 `SUBSCRIPTION_CANCEL` 死路径（已知问题）。发布标记 `20261101T135409Z`；DEPLOY_EXIT=0；`DEPLOYED_COMMIT=d7f704d`；`/api/health` 200；`/api/agent` 与 `/api/v1/transfers/prepare` 无会话返回 401 |

同步模板文件（`.env.example`、`deploy/.env.production.example`）会被部署脚本排除规则放过；私有 `.env`、`.env.local`、`deploy/.env.production` 仍被排除。

## 检查

模型设置需执行 `014_app_agent_model.sql`。切换 New API 时先在服务器私有文件备份原模型配置，更新 `AI_BASE_URL`（含 `/v1`）、`AI_API_KEY`、`AI_MODEL`，重新创建应用后检查模型目录及实际工具调用；不得把密钥写入命令参数、仓库或日志。发布脚本检查任务模型与会话偏好两列存在。模型目录、默认模型和会话选择的边界见 [模型设置](MODEL_SETTINGS.md)。

新版演示登录和 `/api/v1/preferences` 依赖 `015_visitor_memory.sql`；页面助手与业务助手的访客任务隔离依赖 `016_app_agent_memory_scope.sql`。先应用迁移再启动应用；自动发布脚本会检查访客表及任务归属列存在。银行 APP 模型按调用读取有效偏好，设置页提供管理；悬浮助手可处理完整明确的偏好口令，并仅在数据库提交后回执。部署前仍须对真实数据库执行归属隔离和删除验收。

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml ps && \
  docker stats --no-stream bankpilot-app bankpilot-postgres'
```

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U bankpilot -d bankpilot < db/invariants.sql'
```

## 备份与恢复

上线多人测试前备份：

```bash
ssh CONTABO-jp 'docker exec bankpilot-postgres pg_dump -U bankpilot -d bankpilot -Fc' > bankpilot.dump
```

五用户模拟历史仅在首次初始化时生成，不提供“重新进入即重置”或公开恢复入口。需要清理测试数据时应先备份并单独走受控运维流程。

## 域名

`deploy/Caddyfile.bankpilot` 从 `BANKPILOT_DOMAIN` 读取站点域名。更换正式域名时只更新服务器环境和 DNS/Cloudflare 配置，不把公网 IP 写入仓库。

正式访问地址为 `https://bank.jung.edu.pl`。
服务器私有环境文件需要同步设置：

```dotenv
BANKPILOT_PUBLIC_URL=https://bank.jung.edu.pl
```

先确认新域名的 HTTPS 证书签发成功，再重新创建应用容器，使公开地址和 IM 授权链接同时生效；不需要重建镜像或修改数据库：

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml \
  up -d --no-deps --wait app
```

银行写操作只接受 `BANKPILOT_PUBLIC_URL` 的完整 Origin；旧域名的过渡代理也不能恢复已退休的工具接口。浏览器登录状态和 PWA 安装属于各自域名，换域名后需重新登录，并从新地址重新添加到主屏幕。

共享 Caddy 的实际配置在 `/opt/premsir-chat/source/Caddyfile.production`。修改前备份，保留其他站点，校验后再热加载。如果宿主机配置曾被原子替换，容器的单文件 bind mount 可能仍指向旧 inode：热加载前必须比较宿主机与容器内文件的校验和；不一致时可将已校验的完整配置复制到容器独立路径并从该路径热加载。宿主机配置仍须保存完整新版本，供容器下次启动挂载使用，不能仅修改容器临时文件。

域名 A 记录直连服务器并不会隐藏源站 IP；需要隐藏源站时，应另行配置代理或 Tunnel，并限制源站入口。
