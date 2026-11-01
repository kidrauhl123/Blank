import { composeFeedPost, getAIStatus } from "./ai";

// 主模型撰写动态：只有 Jev 通过的系统候选才会经过这里。写出来的数字必须全部来自服务端草稿，
// 不能新增数字，也不能有链接或界面标记；任何一条不满足，就保留服务端写好的草稿。
export type FeedText = { title: string; body: string };

const numbersIn = (text: string) => new Set(text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []);
const UNSAFE = /https?:\/\/|\[\[|\]\]|```|<\/?[a-z]/i;

export function acceptWrittenText(draft: FeedText, written: FeedText): FeedText {
  const text = `${written.title} ${written.body}`;
  if (UNSAFE.test(text)) return draft;
  const allowed = numbersIn(`${draft.title} ${draft.body}`);
  for (const number of numbersIn(text)) if (!allowed.has(number)) return draft;
  return { title: written.title, body: written.body };
}

// 未配置模型、超时、格式不对、数字对不上：都保留草稿，不影响动态发布。
export async function writeFeedText(draft: FeedText & { kind: string }): Promise<FeedText> {
  if (!getAIStatus().configured) return { title: draft.title, body: draft.body };
  try {
    const written = await composeFeedPost({ kind: draft.kind, title: draft.title, body: draft.body });
    return acceptWrittenText(draft, written.value);
  } catch {
    return { title: draft.title, body: draft.body };
  }
}
