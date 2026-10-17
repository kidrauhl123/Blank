import { NextResponse } from "next/server";
import { AuthError } from "./auth";

export function apiError(error: unknown, fallback = "REQUEST_FAILED") {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.code, message: authMessage(error.code) }, { status: error.status });
  }
  const code = error instanceof Error ? error.message : fallback;
  const knownStatus: Record<string, number> = {
    INVALID_STATEMENT_MONTH: 400,
    CONFIRMATION_REQUIRED: 400,
    SUBSCRIPTION_NOT_FOUND: 404,
    SUBSCRIPTION_NOT_ACTIVE: 409,
    ACCOUNT_NOT_FOUND: 404,
    RECIPIENT_NOT_FOUND: 404,
    RECIPIENT_AMBIGUOUS: 409,
    CANNOT_TRANSFER_TO_SELF: 409,
    INSUFFICIENT_FUNDS: 409,
    OPERATION_NOT_FOUND: 404,
    OPERATION_NOT_EXECUTABLE: 409,
    CARD_NOT_FOUND: 404,
    AUTH_INVALID: 401,
    AUTH_EXPIRED: 401,
    AUTH_FUSE_ACTIVE: 423,
    AI_NOT_CONFIGURED: 503,
    AI_UPSTREAM_FAILED: 502,
    AI_INVALID_JSON: 502,
    AI_SCHEMA_REJECTED: 502,
    AI_TIMEOUT: 504,
    AI_MODEL_CATALOG_UNAVAILABLE: 503,
    AI_MODEL_NOT_AVAILABLE: 422,
    AGENT_RUN_NOT_FOUND: 404,
    AGENT_RUN_NOT_RESUMABLE: 409,
    AUTHORIZATION_MISMATCH: 409,
    OPERATION_TYPE_NOT_SUPPORTED: 422,
    RESOURCE_REQUIRED: 422,
    BINDING_TOKEN_INVALID: 400,
    CHANNEL_BINDING_MISMATCH: 409,
    CHANNEL_ALREADY_BOUND: 409,
    CHANNEL_IDENTITY_NOT_FOUND: 404,
    OUTBOX_ITEM_NOT_FOUND: 404,
    PUBLIC_URL_NOT_CONFIGURED: 503,
  };
  console.error(error);
  return NextResponse.json({ error: code, message: publicMessage(code) }, { status: knownStatus[code] ?? 500 });
}

function authMessage(code: string) {
  const messages: Record<string, string> = {
    ACCOUNT_CHANGED: "登录账户已发生变化，请重新核对后再确认连接",
    DEMO_PROFILE_REQUIRED: "比赛沙箱请直接选择一位模拟用户进入",
    DEMO_PROFILE_NOT_FOUND: "请选择列表中的模拟用户",
    AUTHENTICATION_REQUIRED: "请先登录",
    SESSION_EXPIRED: "登录已过期，请重新登录",
    INVALID_CREDENTIALS: "手机号或密码不正确",
    LOGIN_TEMPORARILY_LOCKED: "连续登录失败，账户已暂时锁定 15 分钟",
    PHONE_ALREADY_REGISTERED: "该手机号已经注册",
    CUSTOMER_UNAVAILABLE: "账户当前不可用",
    INVALID_REGISTRATION: "请检查姓名、手机号和密码格式",
    MFA_INVALID: "动态验证码不正确",
    MFA_ALREADY_CONFIGURED: "验证器已启用。当前入口仅支持首次设置，请勿覆盖已有验证器。",
    MFA_SETUP_CHANGED: "设置已变更，请重新打开安全中心并使用最新密钥。",
    DEMO_MFA_CONFIRMATION_REQUIRED: "请先确认这是共享的模拟账户，再设置验证器。",
    SECURITY_CONFIGURATION_REQUIRED: "服务器尚未完成安全密钥配置",
    DEPOSIT_REQUIRES_BANK_APP: "入金只能在银行 APP 内操作",
    CARD_ISSUANCE_REQUIRES_BANK_APP: "开卡只能在银行 APP 内操作",
    CARD_MANAGEMENT_REQUIRES_BANK_APP: "卡片写操作只能在银行 APP 内完成",
    AUTHORIZATION_REQUIRES_BANK_APP: "最终授权必须回到银行 APP 完成",
    MFA_SETUP_REQUIRES_BANK_APP: "多因素认证只能在银行 APP 内设置",
    INVALID_ORIGIN: "请求来源未获允许",
    BANK_APP_SESSION_REQUIRED: "此功能只能在银行 APP 登录后使用",
    MEMORY_VISITOR_REQUIRED: "访客记忆标识已失效，请重新选择模拟用户",
    PREFERENCE_INVALID: "偏好内容或操作格式无效，请检查后重试",
    PREFERENCE_VERSION_CONFLICT: "偏好已在别处更新，请刷新后重试",
    PREFERENCE_MEMORY_DISABLED: "长期偏好记忆已关闭，请先启用后再保存",
  };
  return messages[code] ?? "身份验证失败";
}

function publicMessage(code: string) {
  const messages: Record<string, string> = {
    INVALID_STATEMENT_MONTH: "请选择有效的账单月份",
    CONFIRMATION_REQUIRED: "请先确认操作详情",
    SUBSCRIPTION_NOT_FOUND: "没有找到这项订阅",
    SUBSCRIPTION_NOT_ACTIVE: "这项订阅当前不能停止代扣，请刷新后重试",
    ACCOUNT_NOT_FOUND: "没有找到可用账户",
    RECIPIENT_NOT_FOUND: "没有找到该收款人，请核对手机号或姓名",
    RECIPIENT_AMBIGUOUS: "存在同名客户，请使用手机号转账",
    CANNOT_TRANSFER_TO_SELF: "不能向自己的账户转账",
    INSUFFICIENT_FUNDS: "账户可用余额不足",
    OPERATION_NOT_FOUND: "操作不存在或不属于当前用户",
    OPERATION_NOT_EXECUTABLE: "操作当前不可执行",
    CARD_NOT_FOUND: "没有找到可锁定的卡片",
    AUTH_INVALID: "强验证失败，资金未转出",
    AUTH_EXPIRED: "授权已过期，请重新发起",
    AUTH_FUSE_ACTIVE: "连续验证失败，操作已熔断",
    AI_NOT_CONFIGURED: "真实 AI 模型尚未配置，系统不会使用写死回复代替",
    AI_UPSTREAM_FAILED: "AI 服务暂时不可用，本次没有执行银行操作",
    AI_INVALID_JSON: "AI 输出未通过结构校验，本次没有执行银行操作",
    AI_SCHEMA_REJECTED: "AI 输出未通过结构校验，本次没有执行银行操作",
    AI_TIMEOUT: "AI 响应超时，本次没有执行银行操作",
    AI_MODEL_CATALOG_UNAVAILABLE: "模型列表暂时不可用，请稍后重试",
    AI_MODEL_NOT_AVAILABLE: "该模型当前不可用，请重新选择",
    AGENT_RUN_NOT_FOUND: "没有找到对应的 Agent 任务",
    AGENT_RUN_NOT_RESUMABLE: "该 Agent 任务当前不能重复授权",
    AUTHORIZATION_MISMATCH: "授权信息与待执行操作不一致",
    OPERATION_TYPE_NOT_SUPPORTED: "该操作暂不支持通过此渠道执行",
    RESOURCE_REQUIRED: "操作信息不完整，请重新发起",
    BINDING_TOKEN_INVALID: "绑定链接无效、已使用或已过期",
    CHANNEL_ALREADY_BOUND: "该渠道身份已绑定其他账户",
    CHANNEL_IDENTITY_NOT_FOUND: "渠道身份尚未绑定或已解绑",
    CHANNEL_BINDING_MISMATCH: "绑定链接与当前消息渠道不匹配",
    OUTBOX_ITEM_NOT_FOUND: "消息投递任务不存在或已处理",
    PUBLIC_URL_NOT_CONFIGURED: "服务器尚未配置可信公网地址",
  };
  return messages[code] ?? "请求没有完成，请稍后重试";
}

export function assertSameOrigin(request: Request) {
  if (request.headers.has("authorization")) throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
  const origin = request.headers.get("origin");
  if (!origin && ["GET", "HEAD"].includes(request.method)) return;
  const expected = new URL(process.env.BANKPILOT_PUBLIC_URL || request.url).origin;
  if (!origin || origin !== expected) throw new AuthError("INVALID_ORIGIN", 403);
}
