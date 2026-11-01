import type { PoolClient } from "pg";
import { query, withTransaction } from "./db";
import { writeAudit } from "./audit";
import { consumeCustomerTotp } from "./auth";
import type { PasskeyProof } from "./passkey";
import { WALLET_CAPS, TEMPLATES, describeRule, evaluateRuleTransfer, paramsFromInput, payTrustedSmallInput, ruleStage, yuan, type RuleParams, type RuleStatus, type TemplateId } from "./wallet-core";

// 立规矩（Agent 钱包）的数据层。钱包是付款人名下的子账户，免确认的钱只从这里出；
// 规矩要本人强验证（Passkey 或 TOTP）并经过 24 小时冷静期，每一笔是否在规矩内由 wallet-core 的确定性代码判断。
type RuleRow = { id: string; customer_id: string; owner_id: string; template: TemplateId; params: RuleParams; status: RuleStatus;
  authorized_by: "PASSKEY" | "TOTP" | null; authorized_at: Date | null; effective_at: Date | null; paused_reason: string | null; created_at: Date };

// 同一访客的规矩提议、授权、暂停和转账判断都排在这把锁后面：并发时才不会超出条数或额度上限。
async function lockOwner(client: PoolClient, ownerId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wallet-owner:${ownerId}`]);
}
// 转账过账前先拿访客的锁：必须排在任何账户行锁之前，和草稿路径（findCoveringRule）的加锁顺序一致，否则两边会互相等待。
export async function lockRuleOwnerForTransfer(client: PoolClient, customerId: string, operationId: string) {
  const owner = (await client.query<{ owner_id: string }>(
    "SELECT w.owner_id FROM transfers t JOIN wallet_rules w ON w.id=t.rule_id WHERE t.operation_id=$1 AND t.customer_id=$2", [operationId, customerId])).rows[0];
  if (owner) await lockOwner(client, owner.owner_id);
}
// 北京时间本月 1 日 0 点对应的绝对时刻：“本月”按北京时间算，和用户看到的月份一致。
function beijingMonthStart(now: Date) {
  const beijing = new Date(now.getTime() + 8 * 3_600_000);
  return new Date(Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), 1) - 8 * 3_600_000);
}

// 付款人的主账户：第一个 CHECKING、ACTIVE、CNY 账户，先锁住再读余额。
async function payerMainAccount(client: PoolClient, customerId: string) {
  const row = (await client.query<{ id: string; balance: string }>(`SELECT id,available_balance_minor AS balance FROM accounts
    WHERE customer_id=$1 AND account_type='CHECKING' AND status='ACTIVE' AND currency='CNY' ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [customerId])).rows[0];
  if (!row) throw new Error("WALLET_MAIN_ACCOUNT_MISSING");
  return { id: row.id, balanceMinor: Number(row.balance) };
}
// 钱包是付款人名下的系统子账户，按（访客, 客户）懒创建：同一访客切换到另一位客户时，钱不能记到前一位客户名下；余额加行锁，调用方在同一事务里读写它。
async function ensureWallet(client: PoolClient, customerId: string, ownerId: string) {
  const systemCode = `AGENT_WALLET:${ownerId}:${customerId}`;
  await client.query(`INSERT INTO accounts(customer_id,name,account_type,masked_no,currency,available_balance_minor,status,system_code)
    VALUES($1,'Blank 钱包','AGENT_WALLET','WALLET','CNY',0,'ACTIVE',$2) ON CONFLICT (system_code) WHERE system_code IS NOT NULL DO NOTHING`, [customerId, systemCode]);
  const accountId = (await client.query<{ id: string }>("SELECT id FROM accounts WHERE system_code=$1", [systemCode])).rows[0].id;
  await client.query("INSERT INTO wallet_accounts(owner_id,customer_id,account_id) VALUES($1,$2,$3) ON CONFLICT (owner_id,customer_id) DO NOTHING", [ownerId, customerId, accountId]);
  const balance = (await client.query<{ balance: string }>("SELECT available_balance_minor AS balance FROM accounts WHERE id=$1 FOR UPDATE", [accountId])).rows[0];
  return { id: accountId, balanceMinor: Number(balance.balance) };
}
// 收款人按客户 ID 确定，不按姓名猜：找不到、或同名有多位，都直接拒绝。
async function resolveRecipientCustomer(client: PoolClient, name: string, payerId: string) {
  const rows = (await client.query<{ customer_id: string; account_id: string; created_at: Date }>(`SELECT DISTINCT c.id AS customer_id, a.id AS account_id, a.created_at FROM customers c
    JOIN accounts a ON a.customer_id=c.id AND a.account_type='CHECKING' AND a.status='ACTIVE'
    WHERE c.display_name=$1 AND c.status='ACTIVE' AND c.id<>$2 ORDER BY a.created_at, a.id`, [name, payerId])).rows;
  if (rows.length === 0) throw new Error("RECIPIENT_NOT_FOUND");
  if (new Set(rows.map(row => row.customer_id)).size > 1) throw new Error("RECIPIENT_AMBIGUOUS");
  return rows[0];
}
// 把收款人解析的两种失败转成给用户看的话，其他错误照常抛出。
async function findRecipient(client: PoolClient, name: string, payerId: string): Promise<{ customer_id: string } | { error: string }> {
  try {
    return await resolveRecipientCustomer(client, name, payerId);
  } catch (error) {
    if (error instanceof Error && error.message === "RECIPIENT_NOT_FOUND") return { error: `找不到名叫「${name}」的用户。` };
    if (error instanceof Error && error.message === "RECIPIENT_AMBIGUOUS") return { error: `有不止一位用户叫「${name}」，无法确定免确认的是哪一位。` };
    throw error;
  }
}
// 往来次数按账本算：双方 CHECKING 账户都出现在同一笔账务里才算一次。不看明细文字，因为文字是可以随便写的。
async function relationCount(client: PoolClient, payerId: string, recipientId: string) {
  const row = (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM ledger_transactions l
    WHERE l.posted_at > now() - make_interval(days => $3)
      AND EXISTS (SELECT 1 FROM ledger_entries e JOIN accounts a ON a.id=e.account_id
                  WHERE e.ledger_transaction_id=l.id AND a.customer_id=$1 AND a.account_type='CHECKING')
      AND EXISTS (SELECT 1 FROM ledger_entries e JOIN accounts a ON a.id=e.account_id
                  WHERE e.ledger_transaction_id=l.id AND a.customer_id=$2 AND a.account_type='CHECKING')`,
  [payerId, recipientId, WALLET_CAPS.relationWindowDays])).rows[0];
  return row.count;
}

// ---- 提议规矩（模型调用）：校验参数与硬上限，存成待验证的草稿 ----
export async function createRuleDraft(customerId: string, ownerId: string, raw: unknown): Promise<{ ruleId: string; marker: string } | { error: string }> {
  const parsed = payTrustedSmallInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues.map(issue => `${issue.path.join(".") || "参数"}：${issue.message}`).slice(0, 4).join("；") };
  return withTransaction(async client => {
    await lockOwner(client, ownerId);
    const recipientIds: string[] = [];
    for (const name of parsed.data.recipients) {
      const found = await findRecipient(client, name, customerId);
      if ("error" in found) return { error: found.error };
      if (await relationCount(client, customerId, found.customer_id) < WALLET_CAPS.minRelations) return { error: `「${name}」和你的往来不到 ${WALLET_CAPS.minRelations} 次，不是老联系人，不能设成免确认。新收款人要先照常转账确认几次。` };
      recipientIds.push(found.customer_id);
    }
    // 与授权处的上限一致：同时最多保留 3 条，满了就不再提议，免得草稿之后无法授权。
    const open = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM wallet_rules WHERE owner_id=$1 AND status IN ('COOLING','PAUSED')", [ownerId]);
    if (open.rows[0].count >= 3) return { error: "最多同时保留 3 条规矩，请先撤销不用的。" };
    await client.query("UPDATE wallet_rules SET status='DISMISSED' WHERE owner_id=$1 AND status='DRAFT'", [ownerId]);
    const params = paramsFromInput(parsed.data, recipientIds);
    const inserted = await client.query<{ id: string }>("INSERT INTO wallet_rules(customer_id,owner_id,template,params) VALUES($1,$2,'pay_trusted_small',$3::jsonb) RETURNING id", [customerId, ownerId, JSON.stringify(params)]);
    const ruleId = inserted.rows[0].id;
    await writeAudit({ customerId, actorType: "AGENT", eventType: "WALLET_RULE_PROPOSED", summary: "Blank 提议了一条规矩，等待本人强验证", evidence: { ruleId, template: "pay_trusted_small", params } }, client);
    return { ruleId, marker: `[[rule:${ruleId}]]` };
  });
}

export type RuleView = {
  id: string; stage: "DRAFT" | "COOLING" | "ACTIVE" | "PAUSED" | "REVOKED" | "DISMISSED"; template: string; lines: Array<{ label: string; value: string }>;
  authorizedBy: "PASSKEY" | "TOTP" | null; effectiveAt: string | null; pausedReason: string | null; monthPaidMinor: number;
  auth: { passkeys: number; totp: boolean };
};
async function viewOf(customerId: string, ownerId: string, row: RuleRow, now = new Date()): Promise<RuleView> {
  const [paid, passkeys, totp] = await Promise.all([
    query<{ sum: string }>("SELECT COALESCE(sum(amount_minor),0) AS sum FROM transfers WHERE rule_id=$1 AND status='SUCCEEDED' AND executed_at >= $2", [row.id, beijingMonthStart(now)]),
    query<{ count: number }>("SELECT count(*)::int AS count FROM passkey_credentials WHERE owner_id=$1", [ownerId]),
    query("SELECT 1 FROM mfa_totp WHERE customer_id=$1 AND enabled_at IS NOT NULL", [customerId]),
  ]);
  return { id: row.id, stage: ruleStage({ status: row.status, effectiveAt: row.effective_at }, now), template: TEMPLATES[row.template], lines: describeRule(row.template, row.params),
    authorizedBy: row.authorized_by, effectiveAt: row.effective_at?.toISOString() ?? null, pausedReason: row.paused_reason, monthPaidMinor: Number(paid.rows[0].sum),
    auth: { passkeys: passkeys.rows[0].count, totp: Boolean(totp.rowCount) } };
}
export async function getRuleView(customerId: string, ownerId: string, ruleId: string) {
  const row = (await query<RuleRow>("SELECT * FROM wallet_rules WHERE id=$1 AND customer_id=$2 AND owner_id=$3", [ruleId, customerId, ownerId])).rows[0];
  return row ? viewOf(customerId, ownerId, row) : null;
}

// ---- 本人强验证后，规矩进入 24 小时冷静期，并全渠道通知 ----
export type StrongProof = { method: "TOTP"; code: string } | PasskeyProof;
async function notifyNewRule(client: PoolClient, customerId: string, ownerId: string, row: RuleRow, effectiveAt: Date) {
  const hours = Math.round(WALLET_CAPS.cooldownMs / 3_600_000);
  await client.query(`INSERT INTO feed_posts(customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids,visitor_owner_id)
    VALUES($1,$2,'rule',$3,$4,'规矩',true,'{"type":"recipe","blocks":[]}'::jsonb,'{}',$5) ON CONFLICT(customer_id,dedupe_key) DO NOTHING`,
  [customerId, `rule:${row.id}:created`, `你新立了一条规矩，${hours} 小时后生效`,
    `${describeRule(row.template, row.params).slice(1, 4).map(line => `${line.label}：${line.value}`).join("；")}。不是你本人？现在就到「个人中心 → 规矩与钱包」撤销。`, ownerId]);
  const channels = await client.query<{ id: string; channel_type: string }>("SELECT id,channel_type FROM channel_identities WHERE customer_id=$1 AND status='ACTIVE'", [customerId]);
  for (const channel of channels.rows) await client.query(`INSERT INTO channel_outbox(channel_identity_id,customer_id,channel_type,dedupe_key,payload)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`, [channel.id, customerId, channel.channel_type, `wallet-rule:${row.id}:${channel.id}`,
    JSON.stringify({ message: `Blank：你刚刚新立了一条规矩，${hours} 小时后生效。不是你本人？请立刻打开 Blank，在「个人中心 → 规矩与钱包」撤销。` })]);
  await writeAudit({ customerId, actorType: "USER", eventType: "WALLET_RULE_AUTHORIZED", summary: "客户本人强验证后立了一条规矩，进入冷静期并已通知所有渠道",
    evidence: { ruleId: row.id, effectiveAt: effectiveAt.toISOString(), channelsNotified: channels.rowCount } }, client);
}
export async function authorizeRule(customerId: string, ownerId: string, ruleId: string, proof: StrongProof, now = new Date()): Promise<{ ok: true } | { ok: false; error: "RULE_NOT_FOUND" | "RULE_NOT_PENDING" | "PASSKEY_INVALID" | "MFA_INVALID" | "MFA_REPLAYED" | "AUTH_FUSE_ACTIVE" | "MFA_NOT_CONFIGURED" }> {
  // 通行证必须是为这一条规矩签的：挑战里带着规矩编号，别的规矩的签名拿来用就对不上。
  if (proof.method === "PASSKEY" && proof.ruleId !== ruleId) return { ok: false, error: "PASSKEY_INVALID" } as const;
  return withTransaction(async client => {
    await lockOwner(client, ownerId);
    const row = (await client.query<RuleRow>("SELECT * FROM wallet_rules WHERE id=$1 AND customer_id=$2 AND owner_id=$3 FOR UPDATE", [ruleId, customerId, ownerId])).rows[0];
    if (!row) return { ok: false, error: "RULE_NOT_FOUND" } as const;
    if (row.status !== "DRAFT" || now.getTime() - row.created_at.getTime() > 30 * 60_000) return { ok: false, error: "RULE_NOT_PENDING" } as const;
    if (proof.method === "TOTP") {
      const configured = await client.query("SELECT 1 FROM mfa_totp WHERE customer_id=$1 AND enabled_at IS NOT NULL", [customerId]);
      if (!configured.rowCount) return { ok: false, error: "MFA_NOT_CONFIGURED" } as const;
      const outcome = await consumeCustomerTotp(customerId, proof.code, client);
      if (outcome !== "VERIFIED") return { ok: false, error: outcome === "LOCKED" ? "AUTH_FUSE_ACTIVE" : outcome === "REPLAYED" ? "MFA_REPLAYED" : "MFA_INVALID" } as const; // 返回而不是抛出，失败计数才会提交
    }
    const open = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM wallet_rules WHERE owner_id=$1 AND status IN ('COOLING','PAUSED')", [ownerId]);
    if (open.rows[0].count >= 3) return { ok: false, error: "RULE_NOT_PENDING" } as const;
    const effectiveAt = new Date(now.getTime() + WALLET_CAPS.cooldownMs);
    await client.query("UPDATE wallet_rules SET status='COOLING',authorized_by=$2,authorized_at=$3,effective_at=$4 WHERE id=$1", [ruleId, proof.method, now, effectiveAt]);
    await ensureWallet(client, customerId, ownerId);
    await notifyNewRule(client, customerId, ownerId, row, effectiveAt);
    return { ok: true } as const;
  });
}
export async function dismissRule(customerId: string, ownerId: string, ruleId: string) {
  const updated = await query("UPDATE wallet_rules SET status='DISMISSED' WHERE id=$1 AND customer_id=$2 AND owner_id=$3 AND status='DRAFT'", [ruleId, customerId, ownerId]);
  return (updated.rowCount ?? 0) > 0;
}
// 撤销只会收紧权限，所以不需要强验证；一键即可。
export async function revokeRule(customerId: string, ownerId: string, ruleId: string) {
  return withTransaction(async client => {
    await lockOwner(client, ownerId); // 与转账判断排队：撤销之后，这条规矩不会再覆盖任何落账的转账
    const updated = await client.query("UPDATE wallet_rules SET status='REVOKED',revoked_at=now() WHERE id=$1 AND customer_id=$2 AND owner_id=$3 AND status IN ('DRAFT','COOLING','PAUSED')", [ruleId, customerId, ownerId]);
    if (updated.rowCount) await writeAudit({ customerId, actorType: "USER", eventType: "WALLET_RULE_REVOKED", summary: "客户撤销了一条规矩", evidence: { ruleId } }, client);
    return (updated.rowCount ?? 0) > 0;
  });
}
// 手动暂停只会收紧权限，所以不需要强验证。冷静期中的规矩（已经生效的也是 COOLING 状态）都可以暂停。
export async function pauseRule(customerId: string, ownerId: string, ruleId: string) {
  return withTransaction(async client => {
    await lockOwner(client, ownerId); // 与转账判断排队：暂停要么在那笔转账之前生效，要么在之后，不会插在中间
    const updated = await client.query("UPDATE wallet_rules SET status='PAUSED',paused_reason='你手动暂停' WHERE id=$1 AND customer_id=$2 AND owner_id=$3 AND status='COOLING'", [ruleId, customerId, ownerId]);
    if (updated.rowCount) await writeAudit({ customerId, actorType: "USER", eventType: "WALLET_RULE_PAUSED_BY_USER", summary: "客户手动暂停了一条规矩", evidence: { ruleId } }, client);
    return (updated.rowCount ?? 0) > 0;
  });
}
// 异常时暂停这位访客所有冷静期中的规矩。调用方必须在同一事务里执行，并且不能回滚它。动态只说原因，不带金额。
export async function pauseOwnerRules(client: PoolClient, customerId: string, ownerId: string, reason: string) {
  const paused = await client.query<{ id: string }>("UPDATE wallet_rules SET status='PAUSED',paused_reason=$3 WHERE customer_id=$1 AND owner_id=$2 AND status='COOLING' RETURNING id", [customerId, ownerId, reason]);
  const count = paused.rowCount ?? 0;
  if (count === 0) return 0;
  await client.query(`INSERT INTO feed_posts(customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids,visitor_owner_id)
    VALUES($1,$2,'rule',$3,$4,'规矩',true,'{"type":"recipe","blocks":[]}'::jsonb,'{}',$5) ON CONFLICT(customer_id,dedupe_key) DO NOTHING`,
  [customerId, `rule:${ownerId}:paused:${Date.now()}`, "一条规矩因为异常被自动暂停了", `${reason}，规矩已自动暂停，钱包里的钱不会再自动动。到「个人中心 → 规矩与钱包」检查，不是你本人的话请撤销。`, ownerId]);
  await writeAudit({ customerId, actorType: "RISK_ENGINE", eventType: "WALLET_RULES_PAUSED", summary: "异常触发，访客的规矩已被自动暂停", evidence: { count, reason } }, client);
  return count;
}

// ---- 钱包：转入、收回 ----
export async function moveWallet(customerId: string, ownerId: string, direction: "in" | "out", amountMinor: number) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return { ok: false as const, error: "金额必须大于 0。" };
  return withTransaction(async client => {
    await lockOwner(client, ownerId); // 与转账判断用同一把锁：充值、提现和规矩转账不会读到彼此之前的余额
    const main = await payerMainAccount(client, customerId);
    const wallet = await ensureWallet(client, customerId, ownerId);
    if (direction === "in") {
      if (wallet.balanceMinor + amountMinor > WALLET_CAPS.balanceMinor) return { ok: false as const, error: `钱包最多放 ${yuan(WALLET_CAPS.balanceMinor)}，免确认的损失就封顶在这里。` };
      if (main.balanceMinor < amountMinor) return { ok: false as const, error: "主账户余额不足。" };
    } else if (wallet.balanceMinor < amountMinor) return { ok: false as const, error: "钱包里没有这么多。" };
    const [from, to] = direction === "in" ? [main.id, wallet.id] : [wallet.id, main.id];
    const reference = `WALLET-${direction.toUpperCase()}-${crypto.randomUUID()}`;
    const ledger = await client.query<{ id: string }>("INSERT INTO ledger_transactions(reference,transaction_type,description,posted_at) VALUES($1,'WALLET_MOVE',$2,now()) RETURNING id", [reference, direction === "in" ? "转入 Blank 钱包" : "从 Blank 钱包收回"]);
    await client.query("INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction) VALUES($1,$2,$3,'DEBIT'),($1,$4,$5,'CREDIT')", [ledger.rows[0].id, from, -amountMinor, to, amountMinor]);
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1", [from, amountMinor]);
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [to, amountMinor]);
    await client.query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at,metadata) VALUES($1,$2,'转账',$3,now(),$4::jsonb)",
      [main.id, direction === "in" ? "转入 Blank 钱包" : "从 Blank 钱包收回", direction === "in" ? -amountMinor : amountMinor, JSON.stringify({ source: "AGENT_WALLET", ledgerReference: reference })]);
    await writeAudit({ customerId, actorType: "USER", eventType: direction === "in" ? "WALLET_FUNDED" : "WALLET_WITHDRAWN", summary: direction === "in" ? "客户把钱转入 Blank 钱包" : "客户从 Blank 钱包收回资金", evidence: { amountMinor, ledgerReference: reference } }, client);
    return { ok: true as const, balanceMinor: wallet.balanceMinor + (direction === "in" ? amountMinor : -amountMinor) };
  });
}

// ---- 转账时的覆盖判断（W1b 调用）：必须在调用方的事务 client 里执行 ----
// 调用方拿到结果后要照常提交：没有覆盖时这里可能已经暂停了规矩，回滚会让暂停消失。
export type CoveringRule = { covered: true; ruleId: string; walletAccountId: string; walletBalanceMinor: number }
  | { covered: false; reasons: string[]; paused: boolean };
export async function findCoveringRule(client: PoolClient, customerId: string, ownerId: string, recipientCustomerId: string,
  amountMinor: number, dailyTotalMinor: number, now: Date): Promise<CoveringRule> {
  await lockOwner(client, ownerId);
  const candidates = (await client.query<RuleRow>(`SELECT * FROM wallet_rules WHERE status='COOLING' AND effective_at <= $3 AND customer_id=$1 AND owner_id=$2
    AND params->'recipientIds' ? $4 ORDER BY created_at`, [customerId, ownerId, now, recipientCustomerId])).rows;
  if (candidates.length === 0) return { covered: false, reasons: [], paused: false };
  const monthStart = beijingMonthStart(now);
  const wallet = (await client.query<{ account_id: string; balance: string }>(`SELECT w.account_id, a.available_balance_minor AS balance FROM wallet_accounts w
    JOIN accounts a ON a.id=w.account_id WHERE w.owner_id=$1 AND w.customer_id=$2`, [ownerId, customerId])).rows[0];
  const walletAccountId = wallet?.account_id ?? null;
  const walletBalanceMinor = wallet ? Number(wallet.balance) : 0; // 钱包还没建过就按 0 算，不为了查询去创建它
  const ownerRules = "SELECT id FROM wallet_rules WHERE owner_id=$1";
  const ownerMonthPaid = Number((await client.query<{ sum: string }>(`SELECT COALESCE(sum(amount_minor),0) AS sum FROM transfers
    WHERE rule_id IN (${ownerRules}) AND status='SUCCEEDED' AND executed_at >= $2`, [ownerId, monthStart])).rows[0].sum);
  const ownerRecentCount = (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM transfers
    WHERE rule_id IN (${ownerRules}) AND status='SUCCEEDED' AND executed_at > $2`, [ownerId, new Date(now.getTime() - WALLET_CAPS.burstWindowMs)])).rows[0].count;
  const typical = (await client.query<{ avg: string | null }>(`SELECT round(avg(amount_minor))::bigint AS avg FROM transfers
    WHERE rule_id IN (${ownerRules}) AND status='SUCCEEDED' AND executed_at > $2`, [ownerId, new Date(now.getTime() - 30 * 24 * 3_600_000)])).rows[0].avg;
  const beijingHour = new Date(now.getTime() + 8 * 3_600_000).getUTCHours();
  const refusals: Array<{ pause: boolean; reasons: string[] }> = [];
  for (const rule of candidates) {
    const ruleMonthPaid = Number((await client.query<{ sum: string }>(`SELECT COALESCE(sum(amount_minor),0) AS sum FROM transfers
      WHERE rule_id=$1 AND status='SUCCEEDED' AND executed_at >= $2`, [rule.id, monthStart])).rows[0].sum);
    const verdict = evaluateRuleTransfer({
      rule: { status: rule.status, effectiveAt: rule.effective_at, params: rule.params }, now, recipientCustomerId, amountMinor,
      ruleMonthPaidMinor: ruleMonthPaid, ownerMonthPaidMinor: ownerMonthPaid, walletBalanceMinor, dailyTotalMinor,
      ownerRecentCount, typicalAmountMinor: typical === null ? null : Number(typical), beijingHour,
    });
    if (verdict.allowed) {
      // 允许意味着余额不少于本笔金额（大于 0），钱包一定存在；这里是防止以后改动时悄悄放行。
      if (walletAccountId === null) throw new Error("WALLET_ACCOUNT_MISSING");
      return { covered: true, ruleId: rule.id, walletAccountId, walletBalanceMinor };
    }
    refusals.push(verdict);
  }
  let paused = false;
  if (refusals.some(refusal => refusal.pause)) paused = (await pauseOwnerRules(client, customerId, ownerId, "转账的金额或频率异常")) > 0;
  return { covered: false, reasons: refusals[0].reasons, paused };
}

// ---- 规矩与钱包页 ----
export async function walletOverview(customerId: string, ownerId: string) {
  const [wallet, rules, payments, passkeys, totp] = await Promise.all([
    query<{ balance: string }>("SELECT a.available_balance_minor AS balance FROM wallet_accounts w JOIN accounts a ON a.id=w.account_id WHERE w.owner_id=$1 AND w.customer_id=$2", [ownerId, customerId]),
    query<RuleRow>("SELECT * FROM wallet_rules WHERE customer_id=$1 AND owner_id=$2 AND status NOT IN ('DRAFT','DISMISSED') ORDER BY created_at DESC LIMIT 20", [customerId, ownerId]),
    query<{ recipient: string; amount_minor: string; executed_at: Date; rule_id: string }>(`SELECT b.name AS recipient, t.amount_minor, t.executed_at, t.rule_id FROM transfers t
      JOIN beneficiaries b ON b.id=t.beneficiary_id
      WHERE t.rule_id IN (SELECT id FROM wallet_rules WHERE owner_id=$1) AND t.status='SUCCEEDED' ORDER BY t.executed_at DESC LIMIT 10`, [ownerId]),
    query<{ count: number }>("SELECT count(*)::int AS count FROM passkey_credentials WHERE owner_id=$1", [ownerId]),
    query("SELECT 1 FROM mfa_totp WHERE customer_id=$1 AND enabled_at IS NOT NULL", [customerId]),
  ]);
  return { balanceMinor: Number(wallet.rows[0]?.balance ?? 0), caps: { balanceMinor: WALLET_CAPS.balanceMinor, perTxnMinor: WALLET_CAPS.perTxnMinor, monthlyMinor: WALLET_CAPS.monthlyMinor },
    rules: await Promise.all(rules.rows.map(row => viewOf(customerId, ownerId, row))),
    payments: payments.rows.map(row => ({ recipient: row.recipient, amountMinor: Number(row.amount_minor), at: row.executed_at.toISOString(), ruleId: row.rule_id })),
    auth: { passkeys: passkeys.rows[0].count, totp: Boolean(totp.rowCount) } };
}
