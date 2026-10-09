# CONTABO-jp 部署

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

## 首次配置

```bash
cp deploy/.env.production.example deploy/.env.production
openssl rand -hex 32   # 写入 POSTGRES_PASSWORD
openssl rand -hex 32   # 写入 PASSWORD_PEPPER；部署后不得随意更换
```

AI 变量为空时，银行基础功能正常工作，内置助手明确显示未配置且不会输出替代回复。

必须设置 `BANKPILOT_PUBLIC_URL` 为用户实际访问的 HTTPS 域名。机器人变量在取得平台凭据前可留空，此时不要启用对应 profile。

## 发布

已配置服务器上的私有环境文件后，推荐在可访问部署服务器的本机执行：

```bash
bash scripts/deploy.sh CONTABO-jp
```

脚本要求本地改动已提交，只同步当前提交的源码；先备份远端数据库、环境和代码，再构建、停用旧运行时、应用迁移、启动并核对账本不变量、LangGraph 健康与旧接口删除。失败时停止并输出备份路径，不自动恢复数据库。成功后将发布提交写入远端 `DEPLOYED_COMMIT`。首次配置环境及真实机器人平台联调仍按本文步骤完成。

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

## 检查

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

没有“恢复演示数据”命令，因为项目不再维护任何预置业务数据。需要清理测试数据时应先备份并单独走受控运维流程。

## 域名

`deploy/Caddyfile.bankpilot` 从 `BANKPILOT_DOMAIN` 读取站点域名。更换正式域名时只更新服务器环境和 DNS/Cloudflare 配置，不把公网 IP 写入仓库。MCP 客户端使用同一 HTTPS 域名下的 `/api/mcp`。

正式访问地址为 `https://bank.jung.edu.pl`，MCP 入口为 `https://bank.jung.edu.pl/api/mcp`。
服务器私有环境文件需要同步设置：

```dotenv
BANKPILOT_PUBLIC_URL=https://bank.jung.edu.pl
MCP_ALLOWED_ORIGINS=https://bank.jung.edu.pl
```

先确认新域名的 HTTPS 证书签发成功，再重新创建应用容器，使公开地址和 IM 授权链接同时生效；不需要重建镜像或修改数据库：

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml \
  up -d --no-deps --wait app
```

旧域名的网页跳转到新域名，旧 `/api/*` 暂时保留反向代理以兼容现有无浏览器 Origin 的 MCP 客户端。新接入一律使用正式域名。浏览器登录状态和 PWA 安装属于各自域名，换域名后需重新登录，并从新地址重新添加到主屏幕。

共享 Caddy 的实际配置在 `/opt/premsir-chat/source/Caddyfile.production`。修改前备份，保留其他站点，校验后再热加载。如果宿主机配置曾被原子替换，容器的单文件 bind mount 可能仍指向旧 inode：热加载前必须比较宿主机与容器内文件的校验和；不一致时可将已校验的完整配置复制到容器独立路径并从该路径热加载。宿主机配置仍须保存完整新版本，供容器下次启动挂载使用，不能仅修改容器临时文件。

域名 A 记录直连服务器并不会隐藏源站 IP；需要隐藏源站时，应另行配置代理或 Tunnel，并限制源站入口。
