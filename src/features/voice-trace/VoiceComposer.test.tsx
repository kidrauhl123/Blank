// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceComposer } from "./VoiceComposer";

let root: Root;
let container: HTMLDivElement;
const submit = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  submit.mockClear();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<VoiceComposer onSubmit={submit} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`Missing ${label}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("voice composer", () => {
  it("puts recognized speech in an editable draft and never sends it automatically", async () => {
    let emitResult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | undefined;
    class Recognition {
      lang = ""; interimResults = false; maxAlternatives = 0;
      onresult?: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      start() { emitResult = (event) => this.onresult?.(event); }
      stop() { /* browser stub */ }
      abort() { /* browser stub */ }
    }
    Object.defineProperty(window, "SpeechRecognition", { value: Recognition, configurable: true });
    await act(async () => click("点一下说话"));
    await act(async () => emitResult?.({ results: [[{ transcript: "查看本月账单" }]] }));
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("查看本月账单");
    expect(submit).not.toHaveBeenCalled();
    await act(async () => click("核对后发送"));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("查看本月账单");
  });

  it("keeps text entry available when speech recognition is unavailable", async () => {
    Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
    await act(async () => click("点一下说话"));
    expect(container.textContent).toContain("请直接输入文字");
    expect(container.querySelector("textarea")).not.toBeNull();
  });
});
