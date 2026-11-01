import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, beijingToday } from "./life-memory";
import { cancelReservation, listReservations, previewReservation, reservationInput, RESERVATION_CAPS, saveReservation } from "./bank-reservations";
import { db, query } from "./db";

// 用今天之后第一个工作日的上午，避免测试依赖具体日期。
function nextWeekday() {
  const today = beijingToday();
  for (let offset = 2; offset <= RESERVATION_CAPS.maxDaysAhead; offset++) {
    const day = addDays(today, offset);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 5) return day;
  }
  throw new Error("no weekday in range");
}
const queueInput = (date: string) => reservationInput.parse({ kind: "QUEUE", branchId: "BJ-CY-001", service: "personal", date, time: "10:00" });

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("网点预约（真实数据库）", () => {
  const customerId = randomUUID();
  const owners = [randomUUID(), randomUUID()];
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Reservation test',$2)", [customerId, randomUUID()]);
    for (const owner of owners) await query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2)", [owner, randomBytes(32).toString("hex")]);
  });
  afterAll(async () => {
    // Only fixture IDs are removed; this suite never truncates tables.
    await query("DELETE FROM audit_events WHERE customer_id=$1", [customerId]);
    await query("DELETE FROM bank_reservations WHERE customer_id=$1", [customerId]);
    await query("DELETE FROM visitor_memory_owners WHERE id=ANY($1::uuid[])", [owners]);
    await query("DELETE FROM customers WHERE id=$1", [customerId]);
    await db.end();
  });

  it("预览不保存，确认后才生成取号单号；列表只显示已预约的", async () => {
    const date = nextWeekday();
    const draft = await previewReservation(customerId, owners[0], queueInput(date));
    expect(draft).toMatchObject({ summary: expect.stringContaining("取号办理") });
    expect(await listReservations(customerId, owners[0])).toEqual([]);
    const saved = await saveReservation(customerId, owners[0]);
    expect(saved).toMatchObject({ reservationId: (draft as { reservationId: string }).reservationId, ticket: expect.stringMatching(/^Q\d{3}$/) });
    expect(await listReservations(customerId, owners[0])).toEqual([expect.objectContaining({ ticket: (saved as { ticket: string }).ticket })]);
  });

  it("没有草稿时不能保存；别的访客看不到、也取消不了", async () => {
    expect(await saveReservation(customerId, owners[0])).toMatchObject({ error: expect.stringContaining("没有可以保存的预约") });
    const [booked] = await listReservations(customerId, owners[0]);
    expect(await listReservations(customerId, owners[1])).toEqual([]);
    expect(await cancelReservation(customerId, owners[1], booked.reservationId)).toMatchObject({ error: expect.stringContaining("没有找到") });
    expect(await cancelReservation(customerId, owners[0], booked.reservationId)).toMatchObject({ cancelled: true });
    expect(await listReservations(customerId, owners[0])).toEqual([]);
    expect(await cancelReservation(customerId, owners[0], booked.reservationId)).toMatchObject({ error: expect.stringContaining("没有找到") });
  });

  it("未取消的预约最多 10 笔，超过后保存被拒绝", async () => {
    const date = nextWeekday();
    for (let index = 0; index < RESERVATION_CAPS.maxBooked; index++) {
      await previewReservation(customerId, owners[1], queueInput(date));
      expect(await saveReservation(customerId, owners[1])).toMatchObject({ ticket: expect.any(String) });
    }
    await previewReservation(customerId, owners[1], queueInput(date));
    expect(await saveReservation(customerId, owners[1])).toMatchObject({ error: expect.stringContaining("未取消的预约") });
  });
});
