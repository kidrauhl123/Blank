import { AuthError } from "./auth";
import type { PreferenceCommand } from "./preference-command";
import type { VisitorMemoryScope } from "./visitor-memory";
import { clearPreferences, deletePreference, getPreferenceState, savePreference, setPreferenceMemoryEnabled } from "./visitor-preferences";

export async function applyConversationPreference(scope: VisitorMemoryScope | null, command: PreferenceCommand): Promise<string> {
  if (!scope) return "当前浏览器没有可用的偏好记忆标识。请重新选择用户登录后再试；本次没有保存或删除偏好。";
  const state = await getPreferenceState(scope);
  try {
    if (command.kind === "save") {
      await savePreference(scope, command.key, command.value, state.version, "USER_EXPLICIT");
      return "已保存这项回复偏好，有效期为 90 天。银行确认、强验证及交易事实不受偏好影响。";
    }
    if (command.kind === "delete") {
      await deletePreference(scope, command.key, state.version);
      return "已删除这项回复偏好。历史会话和备份不在本次删除范围内。";
    }
    if (command.kind === "clear") {
      await clearPreferences(scope, state.version);
      return "已清空当前访客和用户的回复偏好。历史会话和备份不在本次清空范围内。";
    }
    await setPreferenceMemoryEnabled(scope, command.kind === "enable", state.version);
    return command.kind === "enable" ? "已开启偏好记忆。此前保留且尚未过期的偏好可能再次生效；需要清空时告诉我“清空所有回复偏好”。"
      : "已关闭偏好记忆，助手将不再读取这些偏好；已保存的偏好尚未删除；需要删除时告诉我“清空所有回复偏好”。";
  } catch (error) {
    if (error instanceof AuthError && error.code === "PREFERENCE_MEMORY_DISABLED") return "偏好记忆目前已关闭。告诉我“开启偏好记忆”后即可继续；本次没有保存偏好。";
    throw error;
  }
}
