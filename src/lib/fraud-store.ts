import type { PoolClient } from "pg";
import { writeAudit } from "./audit";
import { withTransaction } from "./db";
import { FRAUD_CAPS, FRAUD_HOTLINE, FRAUD_QUESTIONS, decideFraud, scamPhraseIn, type FraudDecision, type FraudReason } from "./fraud-core";

// 反诈守护的数据部分：发起转账那一刻读信号（在 prepareTransfer 的事务里，和草稿同一个快照），
// 暂缓后写动态和审计，选择“24 小时后再办”时设置暂缓截止时间。纯判断在 fraud-core.ts，这里只负责取数和落库。

// 发起转账时读取信号。只读付款人自己的账本和对话，不读对方的账户。
export async function assessTransfer(client: PoolClient, input: { customerId: string; recipientAccountId: string; amountMinor: number; note: string | null; now: Date }): Promise<FraudDecision> {
  const newRecipient = (await client.query("SELECT 1 FROM transfers t JOIN beneficiaries b ON b.id=t.beneficiary_id WHERE t.customer_id=$1 AND b.settlement_account_id=$2 AND t.status='SUCCEEDED' LIMIT 1",
    [input.customerId, input.recipientAccountId])).rowCount === 0;
  const typical = (await client.query<{ avg: string | null }>("SELECT round(avg(amount_minor))::bigint::text AS avg FROM transfers WHERE customer_id=$1 AND status='SUCCEEDED' AND executed_at > $2",
    [input.customerId, new Date(input.now.getTime() - 90 * 86_400_000)])).rows[0].avg;
  const recentOthers = (await client.query<{ count: number }>(`SELECT count(DISTINCT b.settlement_account_id)::int AS count FROM transfers t JOIN beneficiaries b ON b.id=t.beneficiary_id
    WHERE t.customer_id=$1 AND t.status = 'SUCCEEDED' AND t.executed_at > $2 AND b.settlement_account_id <> $3`,
  [input.customerId, new Date(input.now.getTime() - FRAUD_CAPS.newRecipientWindowMs), input.recipientAccountId])).rows[0].count;
  // 话术来源：这次备注，以及最近一小时里用户自己开场说过的话（语音转写也算）。
  let scamPhrase = scamPhraseIn(input.note);
  if (!scamPhrase) {
    const recent = await client.query<{ start_text: string | null }>("SELECT start_text FROM app_agent_runs WHERE customer_id=$1 AND created_at > $2 ORDER BY created_at DESC LIMIT 20",
      [input.customerId, new Date(input.now.getTime() - FRAUD_CAPS.scamLookbackMs)]);
    for (const row of recent.rows) {
      scamPhrase = scamPhraseIn(row.start_text);
      if (scamPhrase) break;
    }
  }
  const beijingHour = new Date(input.now.getTime() + 8 * 3_600_000).getUTCHours();
  return decideFraud({
    newRecipient,
    amountMinor: input.amountMinor,
    typicalAmountMinor: typical === null ? null : Number(typical),
    beijingHour,
    recentOtherRecipients: recentOthers,
    scamPhrase,
  });
}

// 拦截卡需要的全部内容：原因和问题都是服务端写死的文字。
export function fraudCardOf(reasons: FraudReason[]) {
  return { reasons, questions: FRAUD_QUESTIONS.map(question => ({ id: question.id, text: question.text })), hotline: FRAUD_HOTLINE };
}

// 暂缓发生时：动态里留一条（“事后在动态里留记录”），审计里留原因码。
export async function recordFraudHold(client: PoolClient, input: { customerId: string; ownerId: string | null; operationId: string; reasons: FraudReason[] }) {
  if (input.ownerId) {
    await client.query(`INSERT INTO feed_posts(customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids,visitor_owner_id)
      VALUES($1,$2,'anomaly',$3,$4,'反诈守护',true,'{"type":"recipe","blocks":[]}'::jsonb,'{}',$5) ON CONFLICT(customer_id,dedupe_key) DO NOTHING`,
    [input.customerId, `fraud:${input.operationId}`, "一笔转账被反诈守护暂缓了",
      `原因：${input.reasons.map(reason => reason.text).join("；")}。这笔钱没有转出；要继续，需要你本人强验证，或者等 24 小时。如果对方让你转账，请先拨打 ${FRAUD_HOTLINE}。`,
      input.ownerId]);
  }
  await writeAudit({ customerId: input.customerId, actorType: "POLICY_ENGINE", eventType: "FRAUD_GUARD_TRIGGERED", summary: "反诈守护暂缓了一笔转账，资金未转出",
    operationId: input.operationId, evidence: { codes: input.reasons.map(reason => reason.code) } }, client);
}

// 提交时仍在暂缓期内：返回给调用方的错误，带上可以再办的时间。
export class FraudHoldError extends Error {
  constructor(readonly holdUntil: string) {
    super("FRAUD_HOLD_ACTIVE");
  }
}

// 用户选择“24 小时后再办”：只能对暂缓中的、还没过账的转账设置一次。期间不能确认，到点后仍需要强验证。
// answers 是拦截卡上用户自己选的答案：只记入审计，帮助以后复盘，不参与判断。
export async function holdFraudTransfer(customerId: string, operationId: string, answers: Record<string, "yes" | "no"> = {}) {
  return withTransaction(async client => {
    const row = (await client.query<{ id: string; status: string; fraud_reasons: unknown; hold_until: Date | null }>(
      "SELECT id,status,fraud_reasons,hold_until FROM transfers WHERE operation_id=$1 AND customer_id=$2 FOR UPDATE",
      [operationId, customerId])).rows[0];
    if (!row || row.fraud_reasons === null) throw new Error("TRANSFER_NOT_HELD");
    if (row.status !== "AWAITING_AUTH" || row.hold_until !== null) throw new Error("TRANSFER_NOT_HELD");
    const now = (await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0].at;
    const holdUntil = new Date(now.getTime() + FRAUD_CAPS.holdMs);
    await client.query("UPDATE transfers SET hold_until=$2, version=version+1 WHERE id=$1", [row.id, holdUntil]);
    // 全渠道通知：不含金额，只说明有一笔转账被暂缓、什么时候能再办、不是本人就去核实。
    const channels = await client.query<{ id: string; channel_type: string }>("SELECT id,channel_type FROM channel_identities WHERE customer_id=$1 AND status='ACTIVE'", [customerId]);
    for (const channel of channels.rows) {
      await client.query(`INSERT INTO channel_outbox(channel_identity_id,customer_id,channel_type,dedupe_key,payload)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`,
      [channel.id, customerId, channel.channel_type, `fraud-hold:${operationId}:${channel.id}`,
        JSON.stringify({ message: `Blank：你有一笔转账被反诈守护暂缓，24 小时后（北京时间 ${new Date(holdUntil.getTime() + 8 * 3_600_000).toISOString().slice(11, 16)}）才能在 Blank 里确认。不是你本人操作，请立刻打开 Blank 查看，或拨打 96110。` })]);
    }
    await writeAudit({ customerId, actorType: "USER", eventType: "FRAUD_GUARD_COOLING_STARTED", summary: "客户选择 24 小时后再办，暂缓期开始", operationId,
      evidence: { holdUntil: holdUntil.toISOString(), answers } }, client);
    return { holdUntil: holdUntil.toISOString() };
  });
}
