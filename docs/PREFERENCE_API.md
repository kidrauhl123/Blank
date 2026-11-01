# 访客偏好读写接口

更新：2026-11-01。第五步提供服务端存储接口；第六步将有效偏好按调用接入银行 APP 模型；第七步曾在设置页提供管理界面，`62a1ddf` 已移除界面，接口保留。悬浮助手现可处理少量完整、明确的偏好口令，模型本身仍没有写入工具。页面文字、交易备注或模型推测不能当作保存指令。

所有请求使用有效银行会话和访客 Cookie。服务端从会话查当前模拟 profile、从访客 Cookie 哈希查 owner；请求体不接受 owner ID、profile key 或来源类型。写请求必须同源。所有响应使用 `Cache-Control: private, no-store`。

| 方法 | 请求体 | 行为 |
| --- | --- | --- |
| `GET /api/v1/preferences` | 无 | 返回当前范围的启用状态、版本、`scopeTag`、未过期偏好和保留条数；关闭时不返回偏好值 |
| `PUT /api/v1/preferences` | `{"key":"response_detail","value":"brief","expectedVersion":"0","expectedScope":"<scopeTag>"}` | 保存或覆盖一个明确偏好，并从这次保存起重新计算该条 90 天期限 |
| `DELETE /api/v1/preferences` | `{"key":"preferred_name","expectedVersion":"1","expectedScope":"<scopeTag>"}` | 删除一个键；返回实际删除条数 |
| `DELETE /api/v1/preferences` | `{"all":true,"expectedVersion":"1","expectedScope":"<scopeTag>"}` | 清空当前访客和 profile 的全部偏好；返回实际删除条数 |
| `PATCH /api/v1/preferences` | `{"enabled":false,"expectedVersion":"1","expectedScope":"<scopeTag>"}` | 关闭或重新启用当前范围的长期记忆 |

版本是字符串，首次读取时为 `"0"`。每次修改后范围版本加一；旧版本写入返回 409，调用方需要重新读取后由用户决定是否再改。每次写入还必须携带最近一次读取返回的 `scopeTag` 作为 `expectedScope`；它只是范围检测值，不是身份凭据。另一标签页切换模拟用户或访客 Cookie 后，即使两边版本相同，也返回 409，不把旧页编辑写入新范围。缺少 `key` 和 `all:true` 的删除请求不会默认清空全部。保存仅接受 `preferred_name`、`response_language`、`response_detail`；称呼经规范化和内容校验，语言只支持 `zh-CN`/`en`，详略只支持 `brief`/`standard`/`detailed`。无效或夹带其他字段的请求返回 400。

关闭记忆不会删除已有数据。关闭后 `GET` 的 `preferences` 为空、`retainedCount` 显示尚未过期的保留条数，`PUT` 返回 409；单项删除和清空全部仍可用。重新启用会重新看到仍有效的数据。过期值从查询中排除，下一次成功演示登录会清理过期记录；未登录的长期闲置记录可能在物理库中多保留一段时间，但无法被接口读取。

HTTP `PUT` 固定记录 `USER_SETTINGS`（界面已移除，这是接口的记录值）。悬浮助手的明确口令通过 `/api/agent/app` 的已认证会话与访客范围调用相同服务层，保存时记录 `USER_EXPLICIT`；删除、清空、开关也使用当前范围版本。只有完整口令会在调用模型前执行，回执由服务端在数据库提交后生成；无归属、校验失败、冲突或数据库失败时不宣称已完成。QQ/企业微信入口不具备此访客口令能力。

调用方可以单独保存或删除每一项；关闭记忆保留现有值，清空全部需要再次确认。409 冲突或网络结果不确定时，调用方应重新读取后让用户核对，不自动重试写入。这里的“删除”只指当前偏好表中的记录；会话历史、模型既有回复和备份不在该操作范围内。
