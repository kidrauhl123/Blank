import { query, withTransaction } from "./db";
import { addToolToHome, removeToolFromHome } from "./ui-store";
import { toolSpecSchema, type SplitRow, type ToolSpec, type ToolView } from "./tool-spec";

// 小工具的存取。基础数据只来自付款人自己的账本（CHECKING 账户）；前端只用 tool-calc.ts 的公式去算，不再回头请求服务端。
// 日期按北京时间切分，和用户看到的“几号”一致。
const NON_SPENDING = ["转账", "理财", "工资", "入金", "住房"];
const BEIJING_MS = 8 * 3_600_000;
const beijingDay = (at: Date) => new Date(at.getTime() + BEIJING_MS).toISOString().slice(0, 10);
// 关键词里的 % 和 _ 是普通字符，不能当通配符。
const likeEscape = (text: string) => text.replace(/[\\%_]/g, char => `\\${char}`);

export async function createTool(customerId: string, ownerId: string, spec: ToolSpec) {
  const row = await query<{ id: string }>(
    "INSERT INTO interactive_tools(customer_id,visitor_owner_id,kind,spec) VALUES($1,$2,$3,$4::jsonb) RETURNING id",
    [customerId, ownerId, spec.kind, JSON.stringify(spec)],
  );
  return row.rows[0].id;
}

// 只能读到自己的小工具：属于别的客户或别的访客，一律当作不存在。
export async function getToolView(customerId: string, ownerId: string, toolId: string, now = new Date()): Promise<ToolView | null> {
  const row = (await query<{ kind: string; spec: unknown; saved_at: Date | null; created_at: Date }>(
    "SELECT kind,spec,saved_at,created_at FROM interactive_tools WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3",
    [toolId, customerId, ownerId],
  )).rows[0];
  if (!row) return null;
  // 存进去的规格也要再校验一次：数据库里的内容不能绕过模型参数的约束。
  const spec = toolSpecSchema.parse(row.spec);
  const head = { id: toolId, saved: row.saved_at !== null, createdAt: row.created_at.toISOString() };

  if (spec.kind === "slider-simulator") {
    // 理财申购视为储蓄、不算花掉的钱，所以排除“理财”分类。
    const total = (await query<{ total: string }>(
      `SELECT COALESCE(SUM(bt.amount_minor),0)::text AS total FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
       WHERE a.customer_id=$1 AND a.account_type='CHECKING' AND bt.category<>'理财'
       AND bt.occurred_at >= $2::timestamptz - interval '90 days' AND bt.occurred_at <= $2::timestamptz`,
      [customerId, now],
    )).rows[0].total;
    return { ...head, kind: "slider-simulator", spec, base: { monthlyNetMinor: Math.round(Number(total) / 3), monthsObserved: 3 } };
  }

  const from = `${spec.from}T00:00:00+08:00`;
  const to = `${spec.to}T23:59:59.999+08:00`;
  const params: unknown[] = [customerId, from, to, NON_SPENDING];
  let filter = "";
  if (spec.categories?.length) {
    params.push(spec.categories);
    filter += ` AND bt.category = ANY($${params.length}::text[])`;
  }
  if (spec.keywords?.length) {
    const clauses = spec.keywords.map(keyword => {
      params.push(`%${likeEscape(keyword)}%`);
      return `bt.merchant_name ILIKE $${params.length}`;
    });
    filter += ` AND (${clauses.join(" OR ")})`;
  }
  const spending = (await query<{ id: string; merchant_name: string; amount_minor: string; occurred_at: Date }>(
    `SELECT bt.id,bt.merchant_name,bt.amount_minor,bt.occurred_at FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
     WHERE a.customer_id=$1 AND a.account_type='CHECKING' AND bt.amount_minor<0
     AND bt.occurred_at >= $2::timestamptz AND bt.occurred_at <= $3::timestamptz
     AND NOT (bt.category = ANY($4::text[]))${filter}
     ORDER BY bt.occurred_at ASC LIMIT 200`,
    params,
  )).rows;
  const rows: SplitRow[] = spending.map(row => ({ id: row.id, date: beijingDay(row.occurred_at), label: row.merchant_name, amountMinor: -Number(row.amount_minor) }));

  // 朋友转给我的钱：只看这位付款人自己的流水，按 App 里的固定备注“来自<姓名>的转账”匹配。
  const received = (await query<{ total: string }>(
    `SELECT COALESCE(SUM(bt.amount_minor),0)::text AS total FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
     WHERE a.customer_id=$1 AND a.account_type='CHECKING' AND bt.category='转账' AND bt.merchant_name=$2 AND bt.amount_minor>0
     AND bt.occurred_at >= $3::timestamptz AND bt.occurred_at <= $4::timestamptz`,
    [customerId, `来自${spec.friend}的转账`, from, to],
  )).rows[0].total;
  // 只告诉用户“找到了这位演示用户”，不返回对方的任何账户信息。
  const friendFound = Boolean((await query("SELECT 1 FROM customers WHERE display_name=$1 AND status='ACTIVE' AND id<>$2 LIMIT 1", [spec.friend, customerId])).rowCount);

  return { ...head, kind: "split-table", spec, rows, receivedMinor: Number(received), friendFound };
}

// 保存或移出首页：标记和首页布局在同一个事务里写，要么都成功，要么都不写。
export async function setToolSaved(customerId: string, ownerId: string, toolId: string, saved: boolean) {
  return withTransaction(async client => {
    const updated = await client.query("UPDATE interactive_tools SET saved_at=$4 WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3", [toolId, customerId, ownerId, saved ? new Date() : null]);
    if (!updated.rowCount) throw new Error("TOOL_NOT_FOUND");
    if (saved) await addToolToHome(customerId, ownerId, toolId, client);
    else await removeToolFromHome(customerId, ownerId, toolId, client);
  });
}
