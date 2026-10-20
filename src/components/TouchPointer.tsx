"use client";

import { useEffect, useRef } from "react";
import styles from "./TouchPointer.module.css";

// 画布上没有系统指针：鼠标就是一根手指，落点由一个圆形触点表示。
// 触点跟随指针、按下时收缩，和手指压在屏幕上的反馈一致。真实触屏
// （pointerType 为 touch）本来就有手指，不显示这个触点。
export function TouchPointer() {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = layer.current;
    const shell = node?.closest<HTMLElement>("[data-phone-shell]");
    if (!node || !shell) return;
    // 粗指针（手机、平板）不替换指针：只有看得见鼠标指针的设备才需要替代品。
    if (!window.matchMedia("(pointer: fine)").matches) return;

    let box = shell.getBoundingClientRect();
    let visible = false;
    let frame = 0;
    let next = { x: 0, y: 0 };

    const paint = () => {
      frame = 0;
      node.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
    };

    const hide = () => {
      if (!visible) return;
      visible = false;
      node.dataset.visible = "false";
      delete node.dataset.pressed;
    };

    const show = (event: PointerEvent) => {
      if (event.pointerType === "touch") return hide();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      if (x < 0 || y < 0 || x > box.width || y > box.height) return hide();
      next = { x, y };
      if (!visible) {
        visible = true;
        node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        node.dataset.visible = "true";
      }
      // 每帧只写一次位置：跟随指针，又不为每次 pointermove 强制重排。
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const press = (event: PointerEvent) => {
      show(event);
      if (event.pointerType === "touch" || !visible) return;
      node.dataset.pressed = "true";
    };

    const release = () => { delete node.dataset.pressed; };
    const measure = () => { box = shell.getBoundingClientRect(); };
    // 指针离开窗口（而不是离开画布）才隐藏；画布内指针位置始终有效。
    const leaveWindow = (event: PointerEvent) => { if (!event.relatedTarget) hide(); };

    window.addEventListener("pointermove", show, { passive: true });
    window.addEventListener("pointerdown", press, { passive: true });
    window.addEventListener("pointerup", release, { passive: true });
    window.addEventListener("pointercancel", release, { passive: true });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true, capture: true });
    document.addEventListener("pointerout", leaveWindow);
    window.addEventListener("blur", hide);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", show);
      window.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, { capture: true });
      document.removeEventListener("pointerout", leaveWindow);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // 外层只负责位移（transform 由 JS 写入），内层圆点负责外观和收缩：
  // 两者分开，收缩才不会把位移一起缩放掉——CSS 的 scale 先于 transform 生效。
  return (
    <div ref={layer} className={styles.pointer} data-touch-pointer data-visible="false" aria-hidden="true">
      <i className={styles.dot} data-touch-dot />
    </div>
  );
}
