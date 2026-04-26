// 注入小红书页面的内容脚本
// 提供原子级浏览器操作，由 Agent 按需调用

import { captureVideoFrame, extractFrames, findMainVideo, getVideoInfo, seekTo } from "./videoCapture";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "executeTool") {
    executeTool(msg.tool, msg.params)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }
});

async function executeTool(
  tool: string,
  params: Record<string, string | number | boolean>
): Promise<string> {
  switch (tool) {
    case "screenshot":
      return screenshot();

    case "click":
      return click(String(params.selector));

    case "type":
      return type(String(params.selector), String(params.text), Boolean(params.submit));

    case "scroll":
      return scroll(Number(params.pixels || 500));

    case "get_page_content":
      await waitForPageStable();
      return getPageContent(String(params.selector || ""));

    case "get_dom_structure":
      await waitForPageStable();
      return getDomStructure(String(params.selector || "body"), Number(params.depth || 3));

    case "extract_video_frames": {
      const interval = Number(params.interval || 2);
      const selectorEvf = params.selector ? String(params.selector) : undefined;
      return handleExtractVideoFrames(interval, selectorEvf);
    }

    case "capture_video_snapshot": {
      const timeParam = params.time !== undefined ? Number(params.time) : undefined;
      const selectorCvs = params.selector ? String(params.selector) : undefined;
      return handleVideoSnapshot(timeParam, selectorCvs);
    }

    case "hover":
      return hover(String(params.selector));

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

function screenshot(): Promise<string> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "takeScreenshot" }, (response) => {
      resolve(response?.dataUrl || "截图失败");
    });
  });
}

async function click(selector: string): Promise<string> {
  try {
    const el = document.querySelector(selector) as HTMLElement;
    if (!el) return `Error: Element not found: ${selector}`;
    el.click();
    await sleep(1500);
    return `Clicked: ${selector}`;
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

async function hover(selector: string): Promise<string> {
  try {
    const el = document.querySelector(selector) as HTMLElement;
    if (!el) return `Error: Element not found: ${selector}`;
    el.dispatchEvent(
      new MouseEvent("mouseenter", { bubbles: true, cancelable: true })
    );
    el.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true })
    );
    await sleep(800);
    return `Hovered: ${selector}`;
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

async function type(selector: string, text: string, submit: boolean): Promise<string> {
  try {
    const el = document.querySelector(selector) as HTMLElement;
    if (!el) return `Error: Element not found: ${selector}`;

    el.focus();

    const isInput = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    const isContentEditable = el.isContentEditable;

    if (isInput) {
      // 原生输入框：用原型 value setter 绕过受控组件拦截
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(el as HTMLInputElement, text);
      } else {
        (el as HTMLInputElement).value = text;
      }
    } else if (isContentEditable) {
      // contenteditable div（小红书搜索框常见）
      el.textContent = text;
    } else {
      // 兜底：尝试 innerText
      el.innerText = text;
    }

    // 触发 input 事件让框架感知变化
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
    );
    if (isInput) {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    if (submit) {
      await sleep(300);

      // 模拟完整的回车按键序列，兼容各种框架
      const keyOptions = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      };

      el.dispatchEvent(new KeyboardEvent("keydown", keyOptions));
      el.dispatchEvent(new KeyboardEvent("keypress", keyOptions));

      // 部分 React 组件监听 input insertLineBreak
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertLineBreak",
          data: "\n",
        })
      );

      el.dispatchEvent(new KeyboardEvent("keyup", keyOptions));

      // 搜索提交后页面会跳转，需要等待页面加载完成
      await sleep(4000);
    }

    return `Typed "${text}" into ${selector}${submit ? " and pressed Enter" : ""}`;
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

async function scroll(pixels: number): Promise<string> {
  window.scrollBy({ top: pixels, behavior: "smooth" });
  // 滚动后等待内容懒加载
  await sleep(2000);
  return `Scrolled ${pixels}px down. Current position: ${window.scrollY}`;
}

function getPageContent(selector: string): string {
  try {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return `Error: Element not found: ${selector}`;

    const texts: string[] = [];
    const walk = (node: Node, depth: number) => {
      if (depth > 8) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text) texts.push(text);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const style = getComputedStyle(node as HTMLElement);
        if (style.display === "none" || style.visibility === "hidden") return;
        for (const child of (node as HTMLElement).childNodes) {
          walk(child, depth + 1);
        }
      }
    };

    walk(root, 0);

    return texts.join("\n");
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

function getDomStructure(selector: string, depth: number): string {
  try {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return `Error: Element not found: ${selector}`;

    return describeElement(root as HTMLElement, 0, depth);
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

function describeElement(el: HTMLElement, level: number, maxDepth: number): string {
  const indent = "  ".repeat(level);
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes =
    el.className && typeof el.className === "string"
      ? `.${el.className.trim().split(/\s+/).join(".")}`
      : "";
  const attrs: string[] = [];
  if (el.getAttribute("placeholder"))
    attrs.push(`placeholder="${el.getAttribute("placeholder")}"`);
  if (el.getAttribute("type")) attrs.push(`type="${el.getAttribute("type")}"`);
  if (el.getAttribute("href")) attrs.push(`href="${el.getAttribute("href")}"`);
  if (el.getAttribute("role")) attrs.push(`role="${el.getAttribute("role")}"`);
  if (el.getAttribute("aria-label"))
    attrs.push(`aria-label="${el.getAttribute("aria-label")}"`);

  const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
  const text =
    el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE
      ? el.textContent?.trim().substring(0, 50)
      : "";
  const textStr = text ? ` "${text}"` : "";

  let result = `${indent}<${tag}${id}${classes}${attrStr}${textStr}>\n`;

  if (level < maxDepth) {
    for (const child of el.children) {
      result += describeElement(child as HTMLElement, level + 1, maxDepth);
    }
  } else if (el.children.length > 0) {
    result += `${indent}  ... (${el.children.length} children)\n`;
  }

  return result;
}

/**
 * 等待页面稳定：
 * 1. document.readyState === 'complete'
 * 2. 没有明显的 loading 元素
 * 3. 两次 DOM 高度变化小于阈值
 */
async function waitForPageStable(maxWaitMs = 8000): Promise<void> {
  const start = Date.now();
  const loadingSelectors = [
    ".loading",
    ".spinner",
    ".skeleton",
    "[class*='loading']",
    "[class*='spin']",
    "[class*='skeleton']",
  ];

  // 等待 document.readyState
  while (document.readyState !== "complete" && Date.now() - start < maxWaitMs) {
    await sleep(300);
  }

  // 等待 loading 元素消失
  let lastHeight = document.body?.scrollHeight || 0;
  let stableCount = 0;

  while (Date.now() - start < maxWaitMs) {
    await sleep(500);

    const hasLoading = loadingSelectors.some((sel) =>
      document.querySelector(sel)
    );
    if (hasLoading) {
      stableCount = 0;
      continue;
    }

    const currentHeight = document.body?.scrollHeight || 0;
    if (Math.abs(currentHeight - lastHeight) < 50) {
      stableCount++;
      if (stableCount >= 2) return; // 连续两次高度稳定
    } else {
      stableCount = 0;
    }
    lastHeight = currentHeight;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 抽帧分析视频：均匀截取多帧并返回 base64 列表。
 */
async function handleExtractVideoFrames(interval = 2, selector?: string): Promise<string> {
  const video = findMainVideo(selector);
  if (!video) throw new Error(selector ? `未找到选择器对应的视频: ${selector}` : "页面未找到视频元素");

  const info = getVideoInfo(video);
  if (!info.duration || info.duration <= 0) {
    throw new Error("视频时长不可用，可能尚未加载完成");
  }

  const frames = await extractFrames(video, interval);

  // 返回 JSON：包含视频元信息 + 帧列表
  return JSON.stringify(
    {
      video_info: info,
      frames: frames.map((f) => ({
        time: f.time,
        data_url: f.dataUrl,
        // 为了节省空间，也可以只返回缩略图或上传到后端后再发 URL
      })),
      frame_count: frames.length,
    },
    null,
    2
  );
}

/**
 * 截取视频画面（单帧）。
 * 如果传了 time，会先 pause → seek → 截图 → 恢复原状态，确保精确。
 * 如果没传 time，直接抓拍当前画面。
 */
async function handleVideoSnapshot(time?: number, selector?: string): Promise<string> {
  const video = findMainVideo(selector);
  if (!video) throw new Error(selector ? `未找到选择器对应的视频: ${selector}` : "页面未找到视频元素");

  const info = getVideoInfo(video);
  let dataUrl: string;
  let capturedTime: number;

  if (time !== undefined && time >= 0 && isFinite(time)) {
    const originalTime = video.currentTime;
    const originalPaused = video.paused;

    video.pause();
    await seekTo(video, time);
    dataUrl = captureVideoFrame(video);
    capturedTime = video.currentTime;

    // 恢复
    await seekTo(video, originalTime);
    if (!originalPaused) video.play();
  } else {
    dataUrl = captureVideoFrame(video);
    capturedTime = info.currentTime;
  }

  return JSON.stringify(
    {
      video_info: info,
      snapshot: { time: capturedTime, data_url: dataUrl },
    },
    null,
    2
  );
}
