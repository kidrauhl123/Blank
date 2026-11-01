# 本地部署：在自己的电脑上运行一份 Blank

这份文档讲怎么在自己的电脑上跑起一份 Blank：数据库、应用、可选的模型配置和可选服务。线上部署（CONTABO-jp 服务器）见 [部署说明](DEPLOYMENT.md)。

下面的命令都在仓库根目录执行。

## 需要准备

- Node.js 22（和 CI 使用的版本一致）
- Git
- Docker（Docker Desktop，或 Docker Engine 加 Compose 插件），用来运行 PostgreSQL 17。不想用 Docker 的话见下方“不用 Docker”。
- 仓库访问权限：`kidrauhl123/Blank` 是私有仓库，需要被授权；也可以用发给你的源码压缩包。

## 1. 获取代码

```bash
git clone git@github.com:kidrauhl123/Blank.git
cd Blank
```

用压缩包时，解压后进入解压出来的目录即可。

## 2. 写配置文件

```bash
cp .env.example .env.local
```

用 `openssl rand -hex 32` 生成一个随机值，填到 `.env.local` 里 `PASSWORD_PEPPER=` 的后面，替换掉占位文字。

`PASSWORD_PEPPER` 用于口令哈希，也用于加密访客自己填写的模型密钥。数据库建好以后不要再改它：改了之后，已保存的口令校验和模型密钥都会失效。`.env.local` 只留在你的电脑上，不要提交到 Git。

`.env.example` 里的其他默认值已经适合本机运行：

- `DATABASE_URL` 指向 `127.0.0.1:54329`，即下一步启动的 Docker 数据库；
- `BANKPILOT_PUBLIC_URL=http://localhost:3000`。

## 3. 安装依赖

```bash
npm install
```

## 4. 启动数据库并建表

```bash
npm run db:setup
```

这一步用 Docker 启动 PostgreSQL 17，只监听 `127.0.0.1:54329`，数据保存在名为 `*_bankpilot_postgres` 的数据卷里，然后按顺序执行 `db/migrations/` 下的全部迁移。已经执行过的迁移会跳过，所以可以重复运行。

检查数据库是否正常：

```bash
npm run db:verify
```

看到 `All banking invariants passed` 即正常。

## 5. 启动应用

```bash
npm run dev
```

打开 <http://localhost:3000>，点击「小土豆」即可进入。第一次进入会初始化五位模拟用户和历史数据；之后重新进入不会重置。

## 6. 配置 AI 助手（可选）

不配置也能使用银行页面。助手会明确显示“真实 AI 模型未配置”，不会用写死的回复冒充 AI。任选一种方式配置：

- **运营方默认模型**：在 `.env.local` 里填写 `AI_BASE_URL`（兼容 OpenAI 的接口地址，含 `/v1`）、`AI_API_KEY` 和 `AI_MODEL`，然后重启 `npm run dev`。这种方式不检查地址，本机或局域网的模型服务（例如 `http://localhost:…/v1`）只能用这种方式接入。
- **自己的接口**：进入后在「设置」页的「自定义模型 API」里填写接口地址、密钥和模型名。保存时服务器会用这把密钥请求一次 `/models`，通过后才加密保存到你的数据库。这种方式要求接口是公开的 `https` 地址。

## 7. 可选服务

- **定时任务**：在 `.env.local` 里设置 `SCHEDULER_TOKEN`（至少 32 个字符，可用 `openssl rand -hex 32` 生成），另开一个终端运行 `npm run scheduler:dev`。细节见 [定时任务](SCHEDULED_TASKS.md)。
- **QQ 与企业微信机器人**：需要先在各自平台创建机器人，见 [QQ 接入](QQ.md) 和 [企业微信接入](WECOM.md)。没有凭据时不要启动对应的 worker。
- **每日 AI 巡检、实时语音**：需要额外的服务凭据，见 [每日 AI 巡检](DAILY_AI_REVIEWS.md) 和 [实时语音](REALTIME_VOICE.md)。不配置时只是这些功能不可用，银行主功能不受影响。

## 8. 验证

```bash
curl http://localhost:3000/api/health
npm run db:verify
npm test
```

健康检查应返回 `"status":"ok"` 和 `"database":"connected"`。进入小土豆后，首页应显示账户余额和流水。`npm test` 只跑单元测试，不需要数据库；完整的集成测试需要一个隔离的测试数据库，见 README 的“验证”一节。

## 9. 停止与清理

- 停止应用：在运行 `npm run dev` 的终端按 `Ctrl+C`。
- 停止数据库但保留数据：`npm run db:down`。数据卷保留，下次 `npm run db:setup` 会接着用原来的数据。
- 删除数据库和全部数据：`docker compose down -v`（只有 `docker-compose` 命令时用 `docker-compose down -v`），然后重新 `npm run db:setup`。

## 不用 Docker

如果你已经有本机的 PostgreSQL 17：

1. 建一个数据库和用户（示例）：
   ```bash
   createuser bankpilot -P
   createdb -O bankpilot bankpilot
   ```
2. 把 `.env.local` 里的 `DATABASE_URL` 改成你的数据库地址，例如 `postgresql://bankpilot:你设的密码@127.0.0.1:5432/bankpilot`。
3. 在一个**全新**的数据库上按文件名顺序执行迁移（与 `npm run db:migrate` 的顺序相同，CI 也是这样做的）：
   ```bash
   for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" || break; done
   ```
4. 检查：`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/invariants.sql`
5. 之后照常 `npm run dev`。

注意：`npm run db:migrate`、`npm run db:verify` 和 `npm run db:down` 依赖 Docker，不能用在不用 Docker 的环境里；这时使用上面的 `psql` 命令。

## 常见问题

- **`docker-compose` 命令找不到**：`scripts/db.sh` 会优先使用 `docker compose`（Compose v2），没有时才使用 `docker-compose`。两者都没有，就需要安装 Docker Compose。
- **端口 54329 或 3000 被占用**：停掉占用端口的程序；或者修改 `docker-compose.yml` 的端口映射，并同步修改 `.env.local` 的 `DATABASE_URL`。
- **设置 TOTP 或保存模型密钥时报 `SECURITY_CONFIGURATION_REQUIRED` 或 `PASSWORD_PEPPER_REQUIRED`**：`PASSWORD_PEPPER` 没有设置。确认 `.env.local` 里已填入随机值，并重启 `npm run dev`（应用不会因为缺少它而无法启动，只是这些功能会拒绝执行）。
- **助手显示“真实 AI 模型未配置”**：这是正常的，见第 6 步。
- **改过 `PASSWORD_PEPPER` 后，口令或自定义模型密钥不能用了**：这是设计如此。改回原值，或者删除数据库重新开始。
- **`npm run db:setup` 失败**：运行 `docker compose ps` 看 `postgres` 是否为 `healthy`，再用 `docker compose logs postgres` 查看原因。

## 安全提醒

- 不要把 `.env.local`、`deploy/.env.production` 或任何密钥提交到 Git。
- 本机数据库只监听 `127.0.0.1`，但仍使用公开的演示口令 `bankpilot`。只在本机使用，不要改成对外开放。
- 演示账户是公开共享的身份，不能用来证明真实客户身份，也不能用于真实资金。
- 运营方的 `AI_API_KEY` 只放在你自己的 `.env.local` 里；访客在设置页填写的密钥只保存在你的数据库里，并用 `PASSWORD_PEPPER` 加密。
