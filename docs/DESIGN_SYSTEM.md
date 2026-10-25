# BankPilot product design system

BankPilot borrows product-design principles from Wise—clear hierarchy, direct actions,
transparent transaction details, high contrast, and accessible zoom—without copying
Wise's proprietary font, logo, or exact brand palette.

Tokens live in `src/app/globals.css`; this file must stay consistent with that source.
Last synced: 2026-10-25.

## Canvas

- Every product route renders inside one fixed phone surface (`PhoneShell`, route group
  `(phone)`): width `min(100vw, 430px)`, height `100dvh` on a narrow viewport. On a wider
  viewport the same surface floats on the desk background with rounded corners and a
  shadow; it never widens into a desktop layout.
- The mouse pointer is a finger on that surface: interaction states use `:active` press
  feedback. There are no hover-dependent affordances, and no component uses `100vw`,
  `100dvh`, or `position: fixed` to reach outside the canvas. Overlays are absolute
  within the canvas.
- **The system cursor does not exist inside the canvas.** `TouchPointer` draws a 30px round
  touch point that follows the mouse and shrinks while pressed, the way the simulated
  device pointer in WeChat DevTools behaves. `PhoneShell` marks the surface with
  `data-pointer="canvas"`, which gives every descendant `cursor: none` (only under
  `@media (pointer: fine)`, so a real touch device keeps its finger) and strips the other
  desktop affordances: scrollbars, `textarea` resize handles, number-input spinners, and
  drag-to-select on UI text (inputs keep selectable text).
- Press feedback is the only pointer state. Never add `:hover` styles, `cursor: pointer`,
  `title` tooltips, or `@media (hover: hover)` blocks. `src/lib/ui-pointer-contract.test.ts`
  guards the styles and `e2e/phone-pointer.pw.ts` checks the rendered canvas.
- The assistant's synthetic pointer uses the same round shape, so the AI hand and the
  user's hand read as one gesture language.

## Typography

- Product font: Inter Variable (SIL Open Font License), with PingFang SC, Noto Sans CJK SC,
  and Microsoft YaHei as Chinese fallbacks.
- Text sizes are fixed tokens: 12 / 14 / 16 / 20 / 24 px. Body copy is 14 or 16 px;
  captions and technical metadata are 12 px. Asset totals and receipt amounts use a
  separate 36 px display token to preserve hierarchy in the user-provided app reference.
- Monospace is reserved for operation IDs, tokens, statuses, and audit records.
- Display text uses a tight line height and letter spacing; body text stays open and readable.

## Visual language

- Ink `#262722` anchors financial information. Lime `#d4ed87` marks primary actions,
  with dark `#26321a` labels; secondary actions keep neutral fills.
- Paper `#efede8` is the app surface; desk `#e3e0d9` is what surrounds the canvas;
  `#ffffff` is the raised card surface.
- Status colors are used only for status: positive `#386451`, warning `#8b631c`,
  danger `#ae4440`.
- One container method at a time. Cards separate by fill only (raised surface on paper),
  with no border; dividers are lines that separate rows, not containers. Inner elements
  do not repeat the outer container's method.
- Spacing uses only 4 / 8 / 12 / 16 / 24 / 32 / 48 px. Radii use at most two tiers:
  `16px` for controls, `28px` for containers.
- Dark mode switches variables only, follows the system setting, and keeps the same
  container method.

## Product writing

- The login entrance explains the competition environment once. Routine screens,
  transaction names, product facts and receipts use plain business names. Data provenance
  remains in internal flags; shared-account effects and authorization requirements stay visible.

- The bottom AI Assistant entry is a full conversation page: edge to edge within the
  phone canvas and above the bottom navigation, with no dimmed backdrop or floating-card
  boundary. Approved automation reveals the business screen with one progress control.

- Cards use a horizontal carousel with native touch scrolling, mouse dragging, keyboard
  arrows, and labelled selection dots. Daily limit and the single Manage entry follow
  the selected card. Locking remains inside the management dialog with human confirmation.

- Banking and Agent are separate user flows. Banking buttons open their own screens
  and call authenticated banking APIs directly; they must never send a hidden prompt
  or switch to chat. The dedicated AI Assistant tab and the clearly labelled home
  AI card open chat without sending a message; the user chooses what to ask.
- Statements aggregate the complete calendar month in Asia/Shanghai, independent
  of the recent-transactions list. Unavailable data must not appear as zero activity.
- Stopping a bank debit is not cancelling the merchant's subscription; label both
  the confirmation and resulting state accordingly.

- Lead with the action or outcome.
- Remove implementation detail unless it changes the user's decision.
- Show recipient, amount, fee/risk, and authorization state before execution.
- Keep sandbox and security disclosures short, visible, and precise.

## Accessibility

- Browser zoom is not disabled.
- Focus states are visible for keyboard users (`:focus-visible` outline, 2 px).
- Pointer targets are at least 44 px (`--target-touch`); icon buttons reach that area
  with padding.
- Reduced-motion preferences disable non-essential motion; functional motion stays
  within 150–250 ms and animates only height, opacity, or color.

## References

- [Wise Design — Get started](https://wise.design/design-at-wise/get-started)
- [Wise brand evolution](https://wise.com/gb/blog/a-brand-for-everywhere-wise-unveils-bold-new-look)
- [Wise transfer flow](https://wise.com/help/articles/2977959/how-do-i-send-money-with-wise)
- [Accessibility at Wise](https://wise.com/help/articles/473W1lKUiKkVFMNeBQgrAG/accessibility-at-wise)
