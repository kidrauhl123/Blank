import { randomInt, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "./db";
import { evaluateTransferRisk } from "./policy";
import { readDailyTransferTotal } from "./transfer-quota";
import { consumeCustomerTotp } from "./auth";
import { transferFingerprint } from "./transfer-binding";
import { writeAudit } from "./audit";
import { getBankStatement } from "./bank-statements";
import { getInvestmentOverview } from "./investments";
import { findCoveringRule, lockRuleOwnerForTransfer } from "./wallet-store";

export async function getBankingOverview(customerId: string) {
  const [customer, accounts, transactions, cards, subscriptions, statement, investments] = await Promise.all([
    query<{ id: string; display_name: string; phone: string; risk_profile: string; mfa_configured: boolean }>(
      `SELECT c.id,c.display_name,c.phone,c.risk_profile,(m.enabled_at IS NOT NULL) AS mfa_configured
       FROM customers c LEFT JOIN mfa_totp m ON m.customer_id=c.id WHERE c.id=$1 AND c.status='ACTIVE'`,
      [customerId],
    ),
    query(
      `SELECT id,name,account_type,account_no,masked_no,currency,available_balance_minor,status
       FROM accounts WHERE customer_id=$1 ORDER BY created_at`,
      [customerId],
    ),
    query(
      `SELECT bt.id,bt.account_id,bt.merchant_name,bt.category,bt.amount_minor,bt.currency,bt.occurred_at,bt.is_anomaly,bt.metadata,
              io.receipt AS investment_receipt
       FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
       LEFT JOIN investment_orders io ON io.operation_id=bt.metadata->>'operationId'
         AND io.customer_id=a.customer_id AND io.account_id=bt.account_id AND io.status='SUCCEEDED'
       WHERE a.customer_id=$1 ORDER BY bt.occurred_at DESC,bt.id DESC LIMIT 50`,
      [customerId],
    ),
    query(
      `SELECT id,card_name,masked_no,card_type,status,online_enabled,overseas_enabled,
              contactless_enabled,daily_limit_minor FROM cards WHERE customer_id=$1 ORDER BY card_name`,
      [customerId],
    ),
    query(
      `SELECT id,merchant_name,amount_minor,billing_cycle,next_charge_at,status
       FROM subscriptions WHERE customer_id=$1 ORDER BY next_charge_at`,
      [customerId],
    ),
    getBankStatement(customerId),
    getInvestmentOverview(customerId),
  ]);
  if (!customer.rows[0]) throw new Error("CUSTOMER_UNAVAILABLE");
  const totalMinor = investments.cashMinor + investments.valueMinor;
  return { customer: customer.rows[0], totalMinor, accounts: accounts.rows, transactions: transactions.rows, cards: cards.rows, subscriptions: subscriptions.rows, statement,
    investmentValueMinor: investments.valueMinor };
}

export async function blockSubscription(customerId: string, subscriptionId: string) {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; status: string; merchant_name: string }>(
      "SELECT id,status,merchant_name FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE",
      [subscriptionId, customerId],
    );
    const subscription = result.rows[0];
    if (!subscription) throw new Error("SUBSCRIPTION_NOT_FOUND");
    if (subscription.status === "BLOCKED") return { id: subscriptionId, status: "BLOCKED", alreadyExecuted: true };
    if (subscription.status !== "ACTIVE") throw new Error("SUBSCRIPTION_NOT_ACTIVE");
    await client.query("UPDATE subscriptions SET status='BLOCKED' WHERE id=$1 AND customer_id=$2", [subscriptionId, customerId]);
    await writeAudit({ customerId, eventType: "SUBSCRIPTION_BLOCKED", actorType: "USER",
      summary: "客户在银行页面确认停止订阅代扣", evidence: { subscriptionId, merchant: subscription.merchant_name, riskLevel: "YELLOW", merchantSubscriptionCancelled: false } }, client);
    return { id: subscriptionId, status: "BLOCKED", alreadyExecuted: false };
  });
}

async function ensureClearingAccount(client: PoolClient) {
  await client.query(
    `INSERT INTO accounts (customer_id,name,account_type,masked_no,currency,available_balance_minor,status,system_code)
     VALUES (NULL,'现金与外部清算','SETTLEMENT','INTERNAL','CNY',0,'ACTIVE','CASH_CLEARING')
     ON CONFLICT (system_code) WHERE system_code IS NOT NULL DO NOTHING`,
  );
  const result = await client.query<{ id: string }>("SELECT id FROM accounts WHERE system_code='CASH_CLEARING' FOR UPDATE");
  return result.rows[0].id;
}

export async function recordDeposit(customerId: string, input: { accountId: string; amountMinor: number; source: "CASH" | "EXTERNAL_TRANSFER"; reference?: string | null }) {
  return withTransaction(async (client) => {
    const account = await client.query<{ id: string; name: string }>(
      `SELECT id,name FROM accounts WHERE id=$1 AND customer_id=$2 AND status='ACTIVE' FOR UPDATE`,
      [input.accountId, customerId],
    );
    if (!account.rows[0]) throw new Error("ACCOUNT_NOT_FOUND");
    const clearingId = await ensureClearingAccount(client);
    const operationId = `DEP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const ledger = await client.query<{ id: string; reference: string; posted_at: string }>(
      `INSERT INTO ledger_transactions (reference,transaction_type,description)
       VALUES ($1,'DEPOSIT',$2) RETURNING id,reference,posted_at::text`,
      [`LED-${operationId}`, input.source === "CASH" ? "现金存入" : "外部账户转入"],
    );
    await client.query(
      `INSERT INTO ledger_entries (ledger_transaction_id,account_id,amount_minor,direction)
       VALUES ($1,$2,$3,'CREDIT'),($1,$4,$5,'DEBIT')`,
      [ledger.rows[0].id, input.accountId, input.amountMinor, clearingId, -input.amountMinor],
    );
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [input.accountId, input.amountMinor]);
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1", [clearingId, input.amountMinor]);
    await client.query(
      `INSERT INTO bank_transactions (account_id,merchant_name,category,amount_minor,occurred_at,metadata)
       VALUES ($1,$2,'入金',$3,now(),$4::jsonb)`,
      [input.accountId, input.source === "CASH" ? "现金存入" : "外部账户转入", input.amountMinor, JSON.stringify({ operationId, reference: input.reference ?? null, source: input.source })],
    );
    await client.query(
      `INSERT INTO cash_deposits (operation_id,customer_id,account_id,amount_minor,source,reference,ledger_transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [operationId, customerId, input.accountId, input.amountMinor, input.source, input.reference ?? null, ledger.rows[0].id],
    );
    await writeAudit({ customerId, eventType: "DEPOSIT_POSTED", actorType: "BANK_CORE", summary: "客户发起的入金已记入双分录账本", operationId, evidence: { accountId: input.accountId, amountMinor: input.amountMinor, source: input.source, ledgerReference: ledger.rows[0].reference } }, client);
    return { operationId, status: "SUCCEEDED", amountMinor: input.amountMinor, receipt: ledger.rows[0] };
  });
}

type Recipient = { customer_id: string; display_name: string; phone: string; account_id: string; masked_no: string };

async function resolveRecipient(customerId: string, recipient: string) {
  const isPhone = /^\+?\d{8,15}$/.test(recipient);
  const result = await query<Recipient>(
    `SELECT c.id AS customer_id,c.display_name,c.phone,a.id AS account_id,a.masked_no
     FROM customers c JOIN accounts a ON a.customer_id=c.id AND a.account_type='CHECKING' AND a.status='ACTIVE'
     WHERE c.status='ACTIVE' AND c.id<>$1 AND ${isPhone ? "c.phone=$2" : "c.display_name=$2"}
     ORDER BY a.created_at LIMIT 2`,
    [customerId, recipient],
  );
  if (!result.rowCount) throw new Error("RECIPIENT_NOT_FOUND");
  if (!isPhone && (result.rowCount ?? 0) > 1) throw new Error("RECIPIENT_AMBIGUOUS");
  return result.rows[0];
}

// 普通草稿和规矩草稿共用：受益人、转账行、策略决定。两条分支只在参数上不同，共用一份 SQL，避免两边漂移。
async function insertPreparedTransfer(client: PoolClient, draft: {
  operationId: string; customerId: string; sourceAccountId: string; recipient: Recipient; amountMinor: number; note: string | null;
  riskLevel: "GREEN" | "YELLOW" | "RED"; requiredAuth: "NONE" | "CONFIRM" | "MFA"; fingerprint: string; expiresAt: string; ruleId: string | null;
  policy: { baseLevel: string; finalLevel: string; matchedRules: string[]; evidence: Record<string, unknown> };
}) {
  const beneficiary = await client.query<{ id: string }>(
    `INSERT INTO beneficiaries (customer_id,name,phone,bank_name,masked_account,settlement_account_id,recipient_customer_id,trusted)
     VALUES ($1,$2,$3,'Blank',$4,$5,$6,false)
     ON CONFLICT (customer_id,settlement_account_id) DO UPDATE SET name=excluded.name,phone=excluded.phone,masked_account=excluded.masked_account,recipient_customer_id=excluded.recipient_customer_id
     RETURNING id`,
    [draft.customerId, draft.recipient.display_name, draft.recipient.phone, draft.recipient.masked_no, draft.recipient.account_id, draft.recipient.customer_id],
  );
  await client.query(
    `INSERT INTO transfers
     (operation_id,idempotency_key,customer_id,from_account_id,beneficiary_id,amount_minor,currency,note,risk_level,required_auth,status,authorization_fingerprint,authorization_expires_at,rule_id)
     VALUES ($1,$2,$3,$4,$5,$6,'CNY',$7,$8,$9,'AWAITING_AUTH',$10,$11,$12)`,
    [draft.operationId, randomUUID(), draft.customerId, draft.sourceAccountId, beneficiary.rows[0].id, draft.amountMinor, draft.note, draft.riskLevel, draft.requiredAuth, draft.fingerprint, draft.expiresAt, draft.ruleId],
  );
  await client.query(
    `INSERT INTO policy_decisions (operation_id,base_level,final_level,matched_rules,evidence)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
    [draft.operationId, draft.policy.baseLevel, draft.policy.finalLevel, JSON.stringify(draft.policy.matchedRules), JSON.stringify(draft.policy.evidence)],
  );
}

// options.ownerId 是访客（规矩的拥有者）；没有访客就没有任何规矩，整个流程和以前一样。
export async function prepareTransfer(customerId: string, input: { fromAccountId: string; recipient: string; amountMinor: number; note?: string | null }, options: { ownerId?: string | null } = {}) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > 100_000_000) throw new Error("INVALID_TRANSFER_AMOUNT");
  const [sourceResult, recipient] = await Promise.all([
    query<{ id: string; name: string; masked_no: string; available_balance_minor: string }>(
      `SELECT id,name,masked_no,available_balance_minor FROM accounts
       WHERE id=$1 AND customer_id=$2 AND status='ACTIVE'`,
      [input.fromAccountId, customerId],
    ),
    resolveRecipient(customerId, input.recipient),
  ]);
  const source = sourceResult.rows[0];
  if (!source) throw new Error("ACCOUNT_NOT_FOUND");
  const clock = await query<{ at: string }>("SELECT clock_timestamp()::text AS at");
  const dailyTotalMinor = await readDailyTransferTotal(customerId, clock.rows[0].at);
  const known = await query("SELECT trusted FROM beneficiaries WHERE customer_id=$1 AND settlement_account_id=$2", [customerId, recipient.account_id]);
  const risk = evaluateTransferRisk({ amountMinor: input.amountMinor, dailyTotalMinor, trustedBeneficiary: Boolean(known.rows[0]?.trusted) });
  const operationId = `TRF-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;

  const result = await withTransaction(async (client) => {
    // 规矩判断用事务内的时刻：覆盖判断、暂停和日期口径都和本次草稿落库在同一个事务里。
    const txClock = await client.query<{ at: string }>("SELECT clock_timestamp()::text AS at");
    const now = new Date(txClock.rows[0].at);
    const cover = options.ownerId ? await findCoveringRule(client, customerId, options.ownerId, recipient.customer_id, input.amountMinor, dailyTotalMinor, now) : null;
    if (cover?.covered === true) {
      // 规矩内：源账户换成付款人的钱包子账户，免确认的钱只从钱包出，主账户不动，损失封顶在钱包余额。
      const wallet = (await client.query<{ id: string; name: string; masked_no: string; available_balance_minor: string; customer_id: string; status: string }>(
        "SELECT id,name,masked_no,available_balance_minor,customer_id,status FROM accounts WHERE id=$1 FOR UPDATE", [cover.walletAccountId])).rows[0];
      if (!wallet || wallet.customer_id !== customerId || wallet.status !== "ACTIVE") throw new Error("ACCOUNT_NOT_FOUND");
      if (Number(wallet.available_balance_minor) < input.amountMinor) throw new Error("INSUFFICIENT_FUNDS");
      const expiry = await client.query<{ expires_at: Date }>("SELECT clock_timestamp()+interval '10 minutes' AS expires_at");
      const expiresAt = expiry.rows[0].expires_at.toISOString();
      const fingerprint = transferFingerprint({ operationId, customerId, source: wallet.id, target: recipient.account_id,
        recipientCustomerId: recipient.customer_id, recipientName: recipient.display_name, recipientPhone: recipient.phone,
        recipientMasked: recipient.masked_no, amountMinor: input.amountMinor, currency: "CNY", note: input.note ?? null, expiresAt });
      await insertPreparedTransfer(client, { operationId, customerId, sourceAccountId: wallet.id, recipient, amountMinor: input.amountMinor, note: input.note ?? null,
        riskLevel: "GREEN", requiredAuth: "NONE", fingerprint, expiresAt, ruleId: cover.ruleId,
        policy: { baseLevel: "GREEN", finalLevel: "GREEN", matchedRules: ["RULE_COVERED", cover.ruleId], evidence: { amountMinor: input.amountMinor, timeZone: "Asia/Shanghai" } } });
      await writeAudit({ customerId, eventType: "TRANSFER_PREPARED", actorType: "USER", summary: "规矩覆盖的转账草稿已创建", operationId,
        evidence: { fromAccountId: wallet.id, recipientCustomerId: recipient.customer_id, amountMinor: input.amountMinor, riskLevel: "GREEN", fingerprint, ruleId: cover.ruleId } }, client);
      return {
        operationId,
        status: "AWAITING_AUTH" as const,
        riskLevel: "GREEN" as const,
        requiredAuth: "NONE" as const,
        authorizationExpiresAt: expiresAt,
        ruleId: cover.ruleId,
        details: {
          amountMinor: input.amountMinor,
          currency: "CNY",
          sourceAccount: { id: wallet.id, name: wallet.name, maskedNo: wallet.masked_no },
          recipient: { name: recipient.display_name, phoneMasked: `${recipient.phone.slice(0, 3)}****${recipient.phone.slice(-4)}`, maskedAccount: recipient.masked_no },
          note: input.note ?? null,
        },
      };
    }
    // 规矩之外走原来的流程。上面的 findCoveringRule 可能已在本事务里暂停了规矩，所以余额不够时不能抛错（抛错会把暂停回滚掉），改为返回标记，事务提交后再抛。
    if (Number(source.available_balance_minor) < input.amountMinor) return { insufficient: true as const };
    const expiry = await client.query<{ expires_at: Date }>("SELECT clock_timestamp()+interval '10 minutes' AS expires_at");
    const expiresAt = expiry.rows[0].expires_at.toISOString();
    const fingerprint = transferFingerprint({ operationId, customerId, source: source.id, target: recipient.account_id,
      recipientCustomerId: recipient.customer_id, recipientName: recipient.display_name, recipientPhone: recipient.phone,
      recipientMasked: recipient.masked_no, amountMinor: input.amountMinor, currency: "CNY", note: input.note ?? null, expiresAt });
    await insertPreparedTransfer(client, { operationId, customerId, sourceAccountId: source.id, recipient, amountMinor: input.amountMinor, note: input.note ?? null,
      riskLevel: risk.finalLevel, requiredAuth: risk.requiredAuth, fingerprint, expiresAt, ruleId: null,
      policy: { baseLevel: risk.baseLevel, finalLevel: risk.finalLevel, matchedRules: risk.matchedRules, evidence: { amountMinor: input.amountMinor, dailyTotalMinor, knownBeneficiary: Boolean(known.rowCount), timeZone: "Asia/Shanghai" } } });
    if (risk.requiredAuth === "MFA") {
      await client.query(
        `INSERT INTO authorization_challenges (customer_id,operation_id,method,code_hash,expires_at)
         VALUES ($1,$2,'TOTP',NULL,$3)`,
        [customerId, operationId, expiresAt],
      );
    }
    await writeAudit({ customerId, eventType: "TRANSFER_PREPARED", actorType: "USER", summary: "客户创建转账草稿，资金尚未转出", operationId, evidence: { fromAccountId: source.id, recipientCustomerId: recipient.customer_id, amountMinor: input.amountMinor, riskLevel: risk.finalLevel, fingerprint } }, client);
    return {
      operationId,
      status: "AWAITING_AUTH" as const,
      riskLevel: risk.finalLevel,
      requiredAuth: risk.requiredAuth,
      authorizationExpiresAt: expiresAt,
      details: {
        amountMinor: input.amountMinor,
        currency: "CNY",
        sourceAccount: { id: source.id, name: source.name, maskedNo: source.masked_no },
        recipient: { name: recipient.display_name, phoneMasked: `${recipient.phone.slice(0, 3)}****${recipient.phone.slice(-4)}`, maskedAccount: recipient.masked_no },
        note: input.note ?? null,
      },
    };
  });
  if ("insufficient" in result) throw new Error("INSUFFICIENT_FUNDS");
  return result;
}

type TransferRow = {
  id: string; operation_id: string; customer_id: string; from_account_id: string; beneficiary_id: string;
  amount_minor: string; currency: string; risk_level: "GREEN" | "YELLOW" | "RED"; required_auth: "NONE" | "CONFIRM" | "MFA";
  status: string; authorization_fingerprint: string; beneficiary_name: string; recipient_customer_id: string;
  target_account_id: string;
  trusted_beneficiary: boolean; prepared_at: Date;
  beneficiary_phone: string | null; masked_account: string; note: string | null; authorization_expires_at: Date;
  rule_id: string | null;
};

export async function commitTransfer(customerId: string, operationId: string, input: { totpCode?: string | null; taskId?: string | null }) {
  return withTransaction(async (client) => {
    // Re-read committed transfers after the customer lock is acquired. A
    // repeatable-read snapshot taken while waiting would miss the prior payer.
    await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    // 规矩转账先拿访客的锁，再锁任何账户行：草稿路径（findCoveringRule）也是先拿访客锁再锁钱包账户，两边顺序一致才不会互相等待。
    await lockRuleOwnerForTransfer(client, customerId, operationId);
    // Serialize all outgoing accounts/channels for this customer. NO KEY UPDATE
    // remains compatible with recipient audit/transfer foreign-key KEY SHARE
    // locks, so opposite-direction transfers do not lock both customers.
    const customer = await client.query("SELECT id FROM customers WHERE id=$1 AND status='ACTIVE' FOR NO KEY UPDATE", [customerId]);
    if (!customer.rowCount) throw new Error("ACCOUNT_NOT_FOUND");
    const result = await client.query<TransferRow>(
      `SELECT t.*,b.name AS beneficiary_name,b.phone AS beneficiary_phone,b.masked_account,b.recipient_customer_id,b.settlement_account_id AS target_account_id,b.trusted AS trusted_beneficiary
       FROM transfers t JOIN beneficiaries b ON b.id=t.beneficiary_id
       WHERE t.operation_id=$1 AND t.customer_id=$2 FOR UPDATE OF t,b`,
      [operationId, customerId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("OPERATION_NOT_FOUND");
    if (row.status === "SUCCEEDED") {
      const receipt = await client.query("SELECT id,reference,posted_at FROM ledger_transactions WHERE transfer_id=$1", [row.id]);
      return { alreadyExecuted: true, operationId, status: "SUCCEEDED" as const, receipt: receipt.rows[0] };
    }
    if (row.status !== "AWAITING_AUTH") throw new Error("OPERATION_NOT_EXECUTABLE");
    const expectedFingerprint = transferFingerprint({ operationId, customerId, source: row.from_account_id, target: row.target_account_id,
      recipientCustomerId: row.recipient_customer_id, recipientName: row.beneficiary_name, recipientPhone: row.beneficiary_phone,
      recipientMasked: row.masked_account, amountMinor: Number(row.amount_minor), currency: row.currency, note: row.note, expiresAt: row.authorization_expires_at });
    if (expectedFingerprint !== row.authorization_fingerprint) throw new Error("AUTHORIZATION_MISMATCH");
    const challenge = row.required_auth === "MFA"
      ? await client.query<{ id: string; attempts: number; expires_at: Date; status: string }>(
        `SELECT id,attempts,expires_at,status FROM authorization_challenges
         WHERE operation_id=$1 ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`,
        [operationId],
      ) : null;
    const accounts = await client.query<{ id: string; customer_id: string; available_balance_minor: string; status: string }>(
      `SELECT id,customer_id,available_balance_minor,status FROM accounts
       WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[row.from_account_id, row.target_account_id]],
    );
    const source = accounts.rows.find((item) => item.id === row.from_account_id);
    const target = accounts.rows.find((item) => item.id === row.target_account_id);
    if (!source || source.customer_id !== customerId || source.status !== "ACTIVE" || !target || target.customer_id !== row.recipient_customer_id || target.status !== "ACTIVE") throw new Error("ACCOUNT_NOT_FOUND");
    if (Number(source.available_balance_minor) < Number(row.amount_minor)) throw new Error("INSUFFICIENT_FUNDS");
    // Capture once after contended customer/operation/challenge/account locks.
    // Use this same instant for classification and all posting timestamps.
    const clock = await client.query<{ at: string }>("SELECT clock_timestamp()::text AS at");
    const postingAt = clock.rows[0].at;
    if (row.authorization_expires_at <= new Date(postingAt)
      // Defense in depth: the bound expiry is authoritative, but a draft whose
      // preparation itself aged out must never survive an expires_at anomaly.
      || new Date(row.prepared_at).getTime() + 10 * 60 * 1000 <= new Date(postingAt).getTime()) throw new Error("AUTH_EXPIRED");
    const dailyTotalMinor = await readDailyTransferTotal(customerId, postingAt, client);
    const risk = evaluateTransferRisk({ amountMinor: Number(row.amount_minor), dailyTotalMinor, trustedBeneficiary: row.trusted_beneficiary });
    if (row.rule_id) {
      // 规矩内的转账过账前按当下的规矩重判：暂停、撤销、超限或收款人已不在名单里，就取消而不是硬过账。
      // 这里不能抛异常：findCoveringRule 可能已在本事务里暂停了规矩，回滚会把暂停撤掉。
      const ruleOwner = await client.query<{ owner_id: string }>("SELECT owner_id FROM wallet_rules WHERE id=$1 AND customer_id=$2", [row.rule_id, customerId]);
      const verdict = ruleOwner.rows[0] ? await findCoveringRule(client, customerId, ruleOwner.rows[0].owner_id, row.recipient_customer_id, Number(row.amount_minor), dailyTotalMinor, new Date(postingAt)) : null;
      // 规矩内的转账绝不升级成强验证：风险升高（当天转账较多）就取消，让用户重新发起。
      if (!verdict || !verdict.covered || verdict.ruleId !== row.rule_id || risk.requiredAuth === "MFA") {
        // 规矩不属于本客户时查不到 owner，按不覆盖处理。
        // 复核给出的具体原因优先；规矩仍覆盖、只是风险升高时，才用“需要本人确认”兜底。
        const reasons = verdict && !verdict.covered && verdict.reasons.length > 0 ? verdict.reasons
          : risk.requiredAuth === "MFA" ? ["当天转账较多，这笔需要你本人确认"] : ["规矩已不再覆盖这笔转账"];
        await client.query("UPDATE transfers SET status='CANCELLED', version=version+1 WHERE id=$1", [row.id]);
        await writeAudit({ customerId, eventType: "TRANSFER_CANCELLED_BY_RULE", actorType: "POLICY_ENGINE", summary: "规矩复核未通过，转账已取消，资金未转出", operationId, evidence: { ruleId: row.rule_id, reasons } }, client);
        return { operationId, status: "CANCELLED" as const, reasons };
      }
    }
    if (row.required_auth !== "MFA" && risk.requiredAuth === "MFA") {
      await client.query("UPDATE transfers SET risk_level='RED',required_auth='MFA',version=version+1 WHERE id=$1", [row.id]);
      const upgraded = await client.query<{ expires_at: Date }>(
        `INSERT INTO authorization_challenges(customer_id,operation_id,method,code_hash,expires_at)
         VALUES($1,$2,'TOTP',NULL,$3) RETURNING expires_at`,
        [customerId, operationId, row.authorization_expires_at],
      );
      const evidence = { amountMinor: Number(row.amount_minor), dailyTotalMinor, postingAt, timeZone: "Asia/Shanghai", operationExecuted: false };
      await client.query(
        `INSERT INTO policy_decisions(operation_id,base_level,final_level,matched_rules,evidence)
         VALUES($1,$2,'RED',$3::jsonb,$4::jsonb)`,
        [operationId, row.risk_level, JSON.stringify(risk.matchedRules), JSON.stringify(evidence)],
      );
      await client.query(
        `UPDATE agent_tasks SET risk_level='RED',updated_at=now()
         WHERE customer_id=$1 AND id IN (SELECT task_id FROM agent_runtime_runs WHERE customer_id=$1 AND operation_id=$2 AND status='INTERRUPTED')`,
        [customerId, operationId],
      );
      await client.query(
        `UPDATE agent_runtime_runs SET interrupt_kind='MFA',updated_at=now(),
          final_reply=jsonb_set(jsonb_set(jsonb_set(final_reply,'{operation,riskLevel}','"RED"'::jsonb),'{operation,requiredAuth}','"MFA"'::jsonb),'{message}',to_jsonb($3::text))
         WHERE customer_id=$1 AND operation_id=$2 AND status='INTERRUPTED'`,
        [customerId, operationId, "当日累计转账已超过 1000 元，资金未转出，请回银行 APP 完成强验证。"],
      );
      await writeAudit({ customerId, operationId, eventType: "TRANSFER_AUTH_UPGRADED", actorType: "RISK_ENGINE", summary: "执行前重算日累计，转账升级为强验证，资金未转出", evidence }, client);
      // Returning commits the upgraded state. Throwing would roll it back. Even
      // a supplied OTP cannot bypass the newly displayed authorization step.
      return { authError: "AUTH_REQUIRED", operationId, status: "AWAITING_AUTH", riskLevel: "RED", requiredAuth: "MFA", authorizationExpiresAt: upgraded.rows[0].expires_at.toISOString() } as const;
    }
    if (row.required_auth === "MFA") {
      const auth = challenge?.rows[0];
      if (auth && auth.attempts >= 3) throw new Error("AUTH_FUSE_ACTIVE");
      if (!auth || auth.expires_at <= new Date(postingAt) || auth.status !== "PENDING") throw new Error("AUTH_EXPIRED");
      if (!input.totpCode) return { authError: "AUTH_REQUIRED", operationId, status: "AWAITING_AUTH", riskLevel: "RED", requiredAuth: "MFA", authorizationExpiresAt: auth.expires_at.toISOString() } as const;
      const verification = await consumeCustomerTotp(customerId, input.totpCode, client);
      if (verification !== "VERIFIED") {
        const attempts = auth.attempts + 1;
        await client.query("UPDATE authorization_challenges SET attempts=$2,status=CASE WHEN $2>=3 THEN 'LOCKED' ELSE status END WHERE id=$1", [auth.id, attempts]);
        await writeAudit({ customerId, eventType: "MFA_REJECTED", actorType: "RISK_ENGINE", summary: "高风险交易 TOTP 验证失败", operationId, evidence: { attempts, reason: verification, fuseActive: verification === "LOCKED" || attempts >= 3 } }, client);
        return { authError: verification === "LOCKED" || attempts >= 3 ? "AUTH_FUSE_ACTIVE" : "AUTH_INVALID" } as const;
      }
      await client.query("UPDATE authorization_challenges SET status='VERIFIED',verified_at=$2 WHERE id=$1", [auth.id, postingAt]);
    }
    await client.query("UPDATE transfers SET status='EXECUTING',confirmed_at=now(),version=version+1 WHERE id=$1", [row.id]);
    const ledger = await client.query<{ id: string; reference: string; posted_at: string }>(
      `INSERT INTO ledger_transactions (reference,transfer_id,transaction_type,description,posted_at)
       VALUES ($1,$2,'TRANSFER',$3,$4) RETURNING id,reference,posted_at::text`,
      [`LED-${operationId}`, row.id, `转账给${row.beneficiary_name}`, postingAt],
    );
    await client.query(
      `INSERT INTO ledger_entries (ledger_transaction_id,account_id,amount_minor,direction)
       VALUES ($1,$2,$3,'DEBIT'),($1,$4,$5,'CREDIT')`,
      [ledger.rows[0].id, row.from_account_id, -Number(row.amount_minor), row.target_account_id, Number(row.amount_minor)],
    );
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor-$2,version=version+1 WHERE id=$1", [row.from_account_id, row.amount_minor]);
    await client.query("UPDATE accounts SET available_balance_minor=available_balance_minor+$2,version=version+1 WHERE id=$1", [row.target_account_id, row.amount_minor]);
    await client.query(
      `INSERT INTO bank_transactions (account_id,merchant_name,category,amount_minor,occurred_at,metadata)
       VALUES ($1,$2,'转账',$3,$8,$4::jsonb),($5,$6,'转账',$7,$8,$4::jsonb)`,
      [row.from_account_id, `转账给${row.beneficiary_name}`, -Number(row.amount_minor), JSON.stringify({ operationId, ledgerReference: ledger.rows[0].reference, ...(row.rule_id ? { ruleId: row.rule_id } : {}) }), row.target_account_id, "来自 Blank 用户的转账", Number(row.amount_minor), postingAt],
    );
    await client.query("UPDATE transfers SET status='SUCCEEDED',executed_at=$2,version=version+1 WHERE id=$1", [row.id, postingAt]);
    if (input.taskId) await client.query("UPDATE agent_tasks SET status='SUCCEEDED',updated_at=now() WHERE id=$1 AND customer_id=$2", [input.taskId, customerId]);
    await writeAudit({ customerId, eventType: "TRANSFER_SUCCEEDED", actorType: "BANK_CORE", summary: "核心账本完成客户间双分录转账", operationId, evidence: { ledgerReference: ledger.rows[0].reference, authorizationFingerprint: row.authorization_fingerprint, balancedEntries: true } }, client);
    if (row.recipient_customer_id) {
      await writeAudit({ customerId: row.recipient_customer_id, eventType: "TRANSFER_RECEIVED", actorType: "BANK_CORE", summary: "收到 Blank 客户转账", operationId, evidence: { ledgerReference: ledger.rows[0].reference, amountMinor: Number(row.amount_minor) } }, client);
    }
    return { operationId, status: "SUCCEEDED" as const, receipt: ledger.rows[0], amountMinor: Number(row.amount_minor), beneficiary: row.beneficiary_name };
  });
}

export async function getOperation(customerId: string, operationId: string) {
  const transfer = await query<{
    operation_id: string; amount_minor: string; currency: string; risk_level: "GREEN" | "YELLOW" | "RED"; required_auth: "NONE" | "CONFIRM" | "MFA";
    status: string; prepared_at: string; executed_at: string | null; beneficiary_name: string; beneficiary_phone: string; authorization_expires_at: Date;
    masked_account: string; source_name: string; source_masked_no: string; note: string | null; rule_id: string | null;
  }>(
    `SELECT t.operation_id,t.amount_minor,t.currency,t.risk_level,t.required_auth,t.status,t.prepared_at::text,t.executed_at::text,t.note,t.authorization_expires_at,t.rule_id,
            b.name AS beneficiary_name,b.phone AS beneficiary_phone,b.masked_account,a.name AS source_name,a.masked_no AS source_masked_no
     FROM transfers t JOIN beneficiaries b ON b.id=t.beneficiary_id JOIN accounts a ON a.id=t.from_account_id
     WHERE t.customer_id=$1 AND t.operation_id=$2`,
    [customerId, operationId],
  );
  if (!transfer.rows[0]) throw new Error("OPERATION_NOT_FOUND");
  const row = transfer.rows[0];
  return {
    operationId: row.operation_id, status: row.status, riskLevel: row.risk_level, requiredAuth: row.required_auth,
    preparedAt: row.prepared_at, executedAt: row.executed_at,
    authorizationExpiresAt: row.authorization_expires_at.toISOString(),
    ruleId: row.rule_id, authorizedByRule: row.rule_id !== null,
    details: {
      amountMinor: Number(row.amount_minor), currency: row.currency,
      sourceAccount: { name: row.source_name, maskedNo: row.source_masked_no },
      recipient: { name: row.beneficiary_name, phoneMasked: row.beneficiary_phone ? `${row.beneficiary_phone.slice(0, 3)}****${row.beneficiary_phone.slice(-4)}` : "—", maskedAccount: row.masked_account },
      note: row.note,
    },
  };
}

export async function issueVirtualCard(customerId: string, accountId: string, cardName: string) {
  return withTransaction(async (client) => {
    const account = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE id=$1 AND customer_id=$2 AND status='ACTIVE' FOR UPDATE",
      [accountId, customerId],
    );
    if (!account.rows[0]) throw new Error("ACCOUNT_NOT_FOUND");
    const suffix = String(randomInt(0, 10_000)).padStart(4, "0");
    const card = await client.query(
      `INSERT INTO cards (customer_id,account_id,card_name,masked_no,card_type,status,daily_limit_minor)
       VALUES ($1,$2,$3,$4,'VIRTUAL','ACTIVE',100000) RETURNING id,card_name,masked_no,card_type,status,daily_limit_minor`,
      [customerId, accountId, cardName, `•••• ${suffix}`],
    );
    await writeAudit({
      customerId,
      eventType: "VIRTUAL_CARD_ISSUED",
      actorType: "BANK_CORE",
      summary: "客户确认后开立虚拟卡",
      evidence: { cardId: card.rows[0].id, accountId, storedCardData: "MASKED_ONLY", riskLevel: "YELLOW" },
    }, client);
    return card.rows[0];
  });
}

export async function lockCard(customerId: string, cardId: string) {
  const result = await query(
    `UPDATE cards SET status='LOCKED' WHERE id=$1 AND customer_id=$2 AND status='ACTIVE'
     RETURNING id,card_name,masked_no,status`,
    [cardId, customerId],
  );
  if (!result.rows[0]) throw new Error("CARD_NOT_FOUND");
  await writeAudit({ customerId, eventType: "CARD_LOCKED", actorType: "USER", summary: "客户明确确认后锁定卡片", evidence: { cardId, riskLevel: "YELLOW" } });
  return result.rows[0];
}

export async function commitPreparedCardLock(
  customerId: string,
  operationId: string,
  input: { resourceId: string; taskId: string },
) {
  return withTransaction(async (client) => {
    const decision = await client.query<{ evidence: { cardId?: string }; task_id: string; task_status: string }>(
      `SELECT p.evidence,p.task_id,t.status AS task_status FROM policy_decisions p JOIN agent_tasks t ON t.id=p.task_id
       WHERE p.operation_id=$1 AND p.final_level='YELLOW' AND t.customer_id=$2 FOR UPDATE OF p`,
      [operationId, customerId],
    );
    if (!decision.rowCount || !["AWAITING_AUTH", "AWAITING_CONFIRMATION"].includes(decision.rows[0].task_status)
      || decision.rows[0].evidence.cardId !== input.resourceId || decision.rows[0].task_id !== input.taskId) {
      throw new Error("AUTHORIZATION_MISMATCH");
    }
    const card = await client.query<{ status: string; card_name: string; masked_no: string }>(
      "SELECT status,card_name,masked_no FROM cards WHERE id=$1 AND customer_id=$2 FOR UPDATE",
      [input.resourceId, customerId],
    );
    if (!card.rows[0]) throw new Error("OPERATION_NOT_FOUND");
    if (card.rows[0].status !== "LOCKED") {
      await client.query("UPDATE cards SET status='LOCKED' WHERE id=$1", [input.resourceId]);
    }
    await client.query(
      "UPDATE agent_tasks SET status='SUCCEEDED',updated_at=now() WHERE id=$1 AND customer_id=$2",
      [input.taskId, customerId],
    );
    await writeAudit({
      customerId,
      eventType: "CARD_LOCKED",
      actorType: "BANK_CORE",
      summary: "客户确认后锁定卡片",
      taskId: input.taskId,
      operationId,
      evidence: { cardId: input.resourceId },
    }, client);
    return {
      operationId,
      status: "SUCCEEDED" as const,
      card: `${card.rows[0].card_name} ${card.rows[0].masked_no}`,
    };
  });
}
