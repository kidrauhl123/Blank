import type { PreferenceKey } from "./visitor-preferences";

export type PreferenceCommand =
  | { kind: "save"; key: PreferenceKey; value: string }
  | { kind: "delete"; key: PreferenceKey }
  | { kind: "clear" | "disable" | "enable" };

// Only an entire, explicit user utterance may change durable memory. This
// parser never reads page text, model output, history, or transaction data.
export function parsePreferenceCommand(message: string): PreferenceCommand | null {
  const text = message.trim().replace(/[。.!！\s]+$/u, "").trim();
  if (!text || text.includes("\n") || text.length > 100) return null;

  if (/^(?:请)?(?:忘掉|忘记|删除|清空)(?:我的)?(?:所有|全部)(?:回复)?偏好$/u.test(text)) return { kind: "clear" };
  if (/^(?:请)?(?:忘掉|忘记|删除)(?:我的)?称呼$/u.test(text)) return { kind: "delete", key: "preferred_name" };
  if (/^(?:请)?(?:忘掉|忘记|删除)(?:我的)?回复语言$/u.test(text)) return { kind: "delete", key: "response_language" };
  if (/^(?:请)?(?:忘掉|忘记|删除)(?:我的)?回复详略$/u.test(text)) return { kind: "delete", key: "response_detail" };
  if (/^(?:请)?(?:不要再记住我的偏好|关闭偏好记忆)$/u.test(text)) return { kind: "disable" };
  if (/^(?:请)?(?:重新开启|开启|启用)偏好记忆$/u.test(text)) return { kind: "enable" };

  // A preference utterance must stand alone. Punctuation like commas or
  // semicolons usually introduces a second request ("以后叫我小陈，顺便转账"),
  // which the name validator would then reject as invalid — silently dropping
  // the banking intent too. Route mixed sentences to the model instead.
  const name = /^(?:(?:请)?记住[，, ]*)?(?:以后|今后)(?:请)?(?:叫我|称呼我)(.+)$/u.exec(text);
  if (name) {
    const candidate = name[1].trim().replace(/^[“"']|[”"']$/gu, "");
    if (/[，,；;、]/u.test(candidate)) return null;
    return { kind: "save", key: "preferred_name", value: candidate };
  }
  const language = /^(?:(?:请)?记住[，, ]*)?(?:以后|今后)(?:都)?用(中文|英文)(?:回复|回答)(?:我)?$/u.exec(text);
  if (language) return { kind: "save", key: "response_language", value: language[1] === "英文" ? "en" : "zh-CN" };
  if (/^(?:(?:请)?记住[，, ]*)?(?:以后|今后)(?:回答|回复)(?:都)?简短(?:一点|些)?$/u.test(text)) return { kind: "save", key: "response_detail", value: "brief" };
  if (/^(?:(?:请)?记住[，, ]*)?(?:以后|今后)(?:(?:回答|回复)(?:都)?详细(?:一点|些)?|详细解释)$/u.test(text)) return { kind: "save", key: "response_detail", value: "detailed" };
  return null;
}
