// 设备的粗略标识：只看“系统 + 浏览器”，不看 IP、不做指纹。浏览器小版本升级、换网络都不会让它变化。
// 这是反诈的一个信号，不是身份证明：清掉浏览器数据就会被当成新设备，结果只是多一步确认。
export function deviceKeyOf(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "unknown";
  const os = /iphone|ipad|ipod/i.test(ua) ? "ios"
    : /android/i.test(ua) ? "android"
      : /windows/i.test(ua) ? "windows"
        : /mac os x|macintosh/i.test(ua) ? "mac"
          : /linux/i.test(ua) ? "linux" : "other";
  // Chrome 的 UA 里也带 Safari 字样，所以先判断 Chrome 系列，再判断 Safari。
  const browser = /edg\//i.test(ua) ? "edge"
    : /chrome\/|crios\//i.test(ua) ? "chrome"
      : /firefox\/|fxios\//i.test(ua) ? "firefox"
        : /safari\//i.test(ua) ? "safari" : "other";
  return `${os}/${browser}`;
}
