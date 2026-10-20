# BankPilot UI 重构：方案与实施结果

基线：`main / a220ee5`，2026-10-13。规范：JungUI 设计规范（本地技能库 `JungUI/skills/jungui/SKILL.md`，不在本仓库内）。

状态（2026-10-20）：方案已实施并上线。分三步落地——`f8f5637`（2026-10-13）完成 token、首页与辅助页重构；`0f55aa9`（2026-10-19）把所有产品页面收敛到固定手机画布；画布内的系统指针也一并移除，改由 `TouchPointer` 画一个圆形触点（2026-10-20）。下方“当前问题及证据”“页面与容器决策”“Token 契约”保留为当时的审计与决策记录，实际取值以 `src/app/globals.css` 与 [设计系统](DESIGN_SYSTEM.md) 为准。

## 方向

轻量、清楚、只做手机形态的银行工具。资产和流水是主角，AI 入口保持稳定。用中性灰表达层级，通过留白、字重和对齐组织信息。

关键决定（与初版草案不同）：**不做桌面加宽布局**。所有产品页面渲染在同一块手机画布内（`PhoneShell` + `(phone)` 路由组），宽视口下画布浮在桌面上、窄视口即整屏手机。鼠标指针在画布上等同手指：指针本身换成半径 15px 的圆形触点（按下收缩），交互只用 `:active` 按压反馈，不用 hover 表达状态，画布内不出现任何系统指针形态。

静态草案仍保留在 [ui-refactor-draft](../ui-refactor-draft/index.html)，仅作历史参考。

## 当前问题及证据（2026-10-13 审计）

| 问题 | 源码位置 | 重构措施 |
| --- | --- | --- |
| 余额、月度概览、最近流水都围成大圆角框，视觉权重接近 | `BankingApp.module.css` 的 `.balanceBlock`、`.section`；`BankingApp.tsx` 的 `HomeView` | 保留卡片块，但统一为“仅色差”一种手段，去掉边框叠加 |
| 正文、交易名、助手回复使用 14px，部分业务说明为 12px | `.txCopy b`、`.transaction > strong`、`FloatingAppAgent.module.css` 的 `.messages p` | 字号收敛到 12 / 14 / 16 / 20 / 24 五档 |
| 手机左右 24px，加卡片内边距后进一步压缩内容 | `.home`、`.listView`、`.authPanel` 的移动端覆盖 | 画布内边距统一为 16 / 24，共用一条左对齐线 |
| 桌面仍限制为 430px、固定高度和内层滚动 | `.phone`、`.viewport`、`--device-width` | 改为所有视口都用同一块画布，画布内滚动 |
| 页面 token 与文档冲突 | `docs/DESIGN_SYSTEM.md` 仍写青柠色、38–54px；`globals.css` 已为中性灰、24px 上限 | 已重写设计文档，删除冲突的旧规定 |
| 缺少系统暗色主题 | `globals.css` 仅 `color-scheme: light`，无暗色变量覆盖 | `prefers-color-scheme` 只切换主题变量 |
| 卡面仍叠色块、渐变、模糊光斑和阴影 | `LiquidBankCard.module.css` | 改单一底色，保留卡名、卡号、状态和限额 |
| 辅助页未完全遵守移动端规范 | `AuditConsole.module.css` 使用 `100vh`；渠道和安全页移动 padding、正文仍有差异 | 审计台改单列并移除 `100vh`；各页统一粘顶页头与安全区 |
| 助手面板和步骤浮层有固定偏移 | `FloatingAppAgent.module.css` 的 `.panel`、`.floating`、`.stepTray` | 全部改为画布内绝对定位，光标坐标改为画布相对 |
| 圆角与尺寸仍有组件特例 | `50%` 圆角、硬编码 78/80/85/137px 等 | 圆角只用 12 / 24 两档；尺寸语义化 |
| 画布内仍是系统指针（手型、箭头、文本 I 型、禁止符号），并带桌面控件特征 | `globals.css` 的 `cursor: pointer`，8 个组件里 47 处 `cursor:` 声明 | 全部删除；画布内 `cursor: none`，由 `TouchPointer` 画圆形触点；去掉滚动条、textarea 拖拽手柄、数字步进箭头和拖选文字 |

## 页面与容器决策

| 区域 | 边界手段 | 信息结构 |
| --- | --- | --- |
| 首页资产 | 仅色差 | 问候 → 资产标签/隐藏 → 金额 → 账户 → 转账/入金 |
| 月度概览 | 仅色差 | 本月金额 → 日期 → 分类行 |
| 首页/明细流水 | 仅色差 + 行分隔 | 对象与时间左对齐，金额右对齐 |
| 卡片实体 | 仅色差 | 单一中性底色，状态单独标明；全卡点击只打开管理详情 |
| 用户入口 | 仅色差 | 五位用户整行可选；共享模拟身份说明保留 |
| 业务表单 | 控件仅边框 | 对象、金额、风险和确认状态清楚；每步只有一个主按钮 |
| 助手 | 无容器回复，用户消息仅色差 | 单一会话；许可、暂停、继续、执行记录分清层级 |
| 安全/渠道/设置/定时任务 | 粘顶页头 + 仅色差分组 | 二级页返回，设置行与必要输入；状态色只表达真实状态 |
| 审计台 | 仅色差，单列 | 服务状态 → 任务列表（自身滚动）→ 详情/执行步骤/策略/事件 |
| 真正模态弹窗 | 浅色仅阴影；深色仅边框 | 画布内底部抽屉；保留焦点陷阱和恢复 |

## Token 契约（现行）

- 间距：4 / 8 / 12 / 16 / 24 / 32 / 48；画布左右 16 / 24。
- 字号：12 / 14 / 16 / 20 / 24。正文 14–16；资产金额与页面标题最大 24。
- 圆角：`--radius-control: 12px`、`--radius-container: 24px`，全项目仅这两档。
- 颜色：中性灰主色 `--accent: #262722`；成功 / 警告 / 错误仅表达状态；暗色只切换变量。
- 画布：`--device-width: 430px`；`--desk` 是画布外底色；`--paper` 是应用底色；`--white` 是卡片底色。
- 点击区：`--target: 32px`、`--target-touch: 44px`；相邻点击区间距 ≥8。
- 交互：无 hover 态，`a:active` / `button:active` 统一降低透明度，特定控件再叠 `--surface-pressed` 底色。
- 动效：只保留功能性动效，150–250ms，只改变颜色 / 透明度 / 高度；尊重 reduced-motion。
- 画布内不使用 `100vw` / `100dvh` / `position: fixed`；弹层与光标相对画布定位。

## 实施顺序（已完成）

1. **基础与首页**：更新设计系统和全局 token；改 `BankingApp` 页面壳、首页和 `AuthScreen`；调整明细行与导航。业务流程未改。
2. **表单与卡片**：统一 `BankDialog`、按钮、输入、确认摘要、回执和错误状态；去掉 `LiquidBankCard` 装饰。保留 Escape、Tab 焦点循环、关闭后恢复焦点与 busy 禁止关闭。
3. **助手**：`FloatingAppAgent` 面板与状态展示改为画布相对定位；保留同一会话及可见页面控制、许可、暂停和恢复。
4. **辅助页**：渠道、安全、审计、设置、定时任务、绑定页统一为画布内全屏页；删除 `--content-narrow` / `--content-wide` 与各页最小宽度断点。
5. **手机画布**：新增 `PhoneShell` 与 `(phone)` 路由组，产品路由整体迁入；`preview/*` 有意留在组外。

## 必须保护的交互契约

- 保留 `data-agent-page`、`data-agent-viewport`、`data-agent-id`、`data-agent-permission` 和必要 label；控件移动后重新观察、重新定位。
- `human` 确认按钮不能因重构变为 Agent 可点击；草稿、黄色确认、红色 TOTP、提交中禁用和未知结果提示保留。
- 查询失败不显示零余额；账户余额与卡片额度区分；银行回执不由助手文案替代。
- 助手返回再打开仍是同一会话；用户干预立即暂停，继续前重新观察；不让新的浮层遮挡操作目标。
- 五用户选择、个人中心切换、安全/渠道/审计返回都可达；共享测试数据说明保留。
- 首页原有的“查看操作记录”独立链接改为个人中心内的“操作记录”入口，避免与底部导航重叠。

## 验收矩阵

| 维度 | 样本 / 条件 | 2026-10-19 结果 |
| --- | --- | --- |
| 设备 | 390×844、430×932、768×1024、1440×900 | 八个路由逐一截图核对；无横向溢出（`scrollWidth == clientWidth`） |
| 主题 | 系统浅色 / 深色 | 浅色与深色均核对首页 |
| 状态 | 初次加载、服务不可用、空列表、任务列表 | 截图核对（登录前与接口替身两种数据） |
| 弹层 | 个人中心、转账表单 | 弹层贴合画布（`x` 与画布一致），不再越出到浏览器窗口 |
| 回归 | `npm run lint`、`npx tsc --noEmit`、`npm test`、`npm run build`、Playwright | 全部通过：lint 无输出，类型检查通过，Vitest 232 通过 / 76 跳过，构建成功，浏览器套件 35 通过 / 5 跳过 |
| 指针 | 桌面 1440×900、手机 390×844 | 桌面：圆点跟随、按下收缩、画布内计算样式全为 `cursor: none`；手机：不渲染圆点；样式表 0 条 `:hover`、0 条组件级 `cursor:` |

## 指针契约（2026-10-20）

画布上的鼠标不是桌面鼠标，是手指。因此不只去掉 hover，系统指针本身也不出现：

- `PhoneShell` 给画布加 `data-pointer="canvas"`；`globals.css` 在 `@media (pointer: fine)` 下把画布内所有元素的 `cursor` 设为 `none`，触屏设备不受影响。
- `TouchPointer`（挂在 `PhoneShell` 内）画一个 30px 的圆点：跟随鼠标、`pointerdown` 收缩到 68%、`pointerup` 还原、离开窗口隐藏。坐标相对画布，滚动/缩放后重新测量。
- 同时清掉其余桌面特征：滚动条、`textarea` 拖拽改大小、`input[type=number]` 步进箭头、界面文字的鼠标拖选（输入框保留可选中）、8 个组件里的 47 处 `cursor:` 声明。
- 助手的合成指针从箭头图标改成同一种圆点，AI 的手和用户的手是同一种形状。
- 守卫：`src/lib/ui-pointer-contract.test.ts` 断言样式表里没有 `:hover`、没有组件级 `cursor:`、全局规则存在；`e2e/phone-pointer.pw.ts` 断言渲染后触点几何、按压收缩、画布内计算样式都是 `cursor: none`、且没有任何 `:hover` 规则或 `title` 提示。

## 证据截图

线上 `https://bank.jung.edu.pl` 实拍，已登录小土豆：

- [桌面 1440×900 的固定手机画布](screenshots/phone-canvas-desktop.png)
- [手机 390×844 的整屏画布](screenshots/phone-canvas-mobile.png)
- [个人中心底部抽屉贴合画布](screenshots/profile-sheet.png)
- [审计台单列布局](screenshots/audit-single-column.png)

画布内圆形触点（本地 1440×900 / 390×844 视口）：

- [圆点停在按钮上](screenshots/touch-pointer-desktop.png)
- [按下瞬间圆点收缩](screenshots/touch-pointer-pressed.png)
- [触屏设备没有圆点](screenshots/touch-pointer-phone.png)
- [线上 1440×900：`e28c1ad` 部署后的真实画布](screenshots/prod-touch-pointer.png)

尚未完成：200% 缩放逐页核对、真机软键盘遮挡输入检查、与 `a220ee5` 的逐页像素对比基线。
