import { AsyncLocalStorage } from "node:async_hooks";

// 当前这一轮“用户本人在 App 里亲手发的话”。立规矩和免确认付款只认它：
// 页面内容、备注、商户名、资讯、工具返回里出现的任何指令都不算。语音转写也不算（source=voice）。
export type UserTurn = { text: string; source: "typed" | "voice" };
const turn = new AsyncLocalStorage<UserTurn | null>();
export const withUserTurn = <T,>(value: UserTurn, work: () => Promise<T>): Promise<T> => turn.run(value, work);
export const currentUserTurn = (): UserTurn | null => turn.getStore() ?? null;
