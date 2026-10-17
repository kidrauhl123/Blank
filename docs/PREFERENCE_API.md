# 访客偏好读写接口

日期：2026-10-17。第五步提供服务端存储接口；第六步将有效偏好按调用接入银行 APP 模型。设置页和对话写入工具尚未接入。接口只面向用户在银行 APP 的明确设置操作，不能把页面文字、交易备注或模型推测当作保存指令。

所有请求使用有效银行会话和访客 Cookie。服务端从会话查当前模拟 profile、从访客 Cookie 哈希查 owner；请求体不接受 owner ID、profile key 或来源类型。写请求必须同源。所有响应使用 `Cache-Control: private, no-store`。

| 方法 | 请求体 | 行为 |
| --- | --- | --- |
| `GET /api/v1/preferences` | 无 | 返回当前范围的启用状态、版本、未过期偏好和保留条数；关闭时不返回偏好值 |
| `PUT /api/v1/preferences` | `{"key":"response_detail","value":"brief","expectedVersion":"0"}` | 保存或覆盖一个明确偏好，并从这次保存起重新计算该条 90 天期限 |
| `DELETE /api/v1/preferences` | `{"key":"preferred_name","expectedVersion":"1"}` | 删除一个键；返回实际删除条数 |
| `DELETE /api/v1/preferences` | `{"all":true,"expectedVersion":"1"}` | 清空当前访客和 profile 的全部偏好；返回实际删除条数 |
| `PATCH /api/v1/preferences` | `{"enabled":false,"expectedVersion":"1"}` | 关闭或重新启用当前范围的长期记忆 |

版本是字符串，首次读取时为 `"0"`。每次修改后范围版本加一；旧版本写入返回 409，调用方需要重新读取后由用户决定是否再改。缺少 `key` 和 `all:true` 的删除请求不会默认清空全部。保存仅接受 `preferred_name`、`response_language`、`response_detail`；称呼经规范化和内容校验，语言只支持 `zh-CN`/`en`，详略只支持 `brief`/`standard`/`detailed`。无效或夹带其他字段的请求返回 400。

关闭记忆不会删除已有数据。关闭后 `GET` 的 `preferences` 为空、`retainedCount` 显示尚未过期的保留条数，`PUT` 返回 409；单项删除和清空全部仍可用。重新启用会重新看到仍有效的数据。过期值从查询中排除，下一次成功演示登录会清理过期记录；未登录的长期闲置记录可能在物理库中多保留一段时间，但无法被接口读取。

服务层预留 `USER_EXPLICIT` 来源供后续对话工具使用；当前 HTTP `PUT` 固定记录 `USER_SETTINGS`。模型已在每次调用时读取有效偏好，但对话尚不能触发保存或删除。存储成功回执只能在数据库提交后生成；当前页面助手不得宣称在对话中已保存或删除偏好。
