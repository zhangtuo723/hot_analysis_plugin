// 注入小红书页面的内容脚本
// 提供原子级浏览器操作，由 Agent 按需调用

import { captureVideoFrame, extractFrames, findMainVideo, getVideoInfo, seekTo } from "./videoCapture";

// 防止重复注册：background.ts 每次工具调用都会再 executeScript 注入一次本文件，
// 顶层代码会被重复执行，listener 会叠加导致 message channel closed 错误。
declare global {
  interface Window {
    __xhsListenerInstalled?: boolean;
  }
}

if (!window.__xhsListenerInstalled) {
  window.__xhsListenerInstalled = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "executeTool") {
      executeTool(msg.tool, msg.params)
        .then((result) => sendResponse({ success: true, result }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }
  });

  // 定期向 background 发 keepalive，防止 Service Worker 休眠导致 WebSocket 断连
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ action: "keepalive" });
    } catch {
      /* ignore */
    }
  }, 20000);
}

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
      return scroll(Number(params.pixels || 500), String(params.selector || ""), String(params.direction || "down"));

    case "scroll_to_element":
      return scrollToElement(String(params.selector));

    case "get_page_content":
      await waitForPageStable();
      return getPageContent(String(params.selector || ""), Number(params.max_depth || 0));

    case "find_element_by_text":
      return findElementByText(
        String(params.keyword),
        String(params.selector || ""),
        Number(params.nth || 1)
      );

    case "get_dom_structure":
      await waitForPageStable();
      return getDomStructure(String(params.selector || "body"), Number(params.depth || 3));

    case "extract_video_frames": {
      const interval = Number(params.interval || 2);
      const selectorEvf = params.selector ? String(params.selector) : "";
      if (!selectorEvf) throw new Error("selector 参数必填");
      return handleExtractVideoFrames(interval, selectorEvf);
    }

    case "capture_video_snapshot": {
      const timeParam = params.time !== undefined ? Number(params.time) : undefined;
      const selectorCvs = params.selector ? String(params.selector) : "";
      if (!selectorCvs) throw new Error("selector 参数必填");
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

async function scroll(pixels: number, selector: string = "", direction: string = "down"): Promise<string> {
  const isUp = direction === "up";
  const delta = isUp ? -pixels : pixels;

  if (selector) {
    const el = document.querySelector(selector) as HTMLElement;
    if (!el) return `Error: Element not found: ${selector}`;
    el.scrollBy({ top: delta, behavior: "smooth" });
    await sleep(2000);
    return `Scrolled ${selector} ${pixels}px ${isUp ? "up" : "down"}. scrollTop: ${el.scrollTop}`;
  }

  window.scrollBy({ top: delta, behavior: "smooth" });
  await sleep(2000);
  return `Scrolled ${pixels}px ${isUp ? "up" : "down"}. Current position: ${window.scrollY}`;
}

async function scrollToElement(selector: string): Promise<string> {
  try {
    const el = document.querySelector(selector) as HTMLElement;
    if (!el) return `Error: Element not found: ${selector}`;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(1500);
    return `Scrolled to element: ${selector}`;
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

function getPageContent(selector: string, maxDepth: number = 0): string {
  try {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return `Error: Element not found: ${selector}`;

    const texts: string[] = [];
    const walk = (node: Node, depth: number) => {
      if (maxDepth > 0 && depth > maxDepth) return;
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

function findElementByText(keyword: string, scopeSelector: string, nth: number): string {
  try {
    const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
    if (!root) return `Error: Scope not found: ${scopeSelector}`;

    const lowerKeyword = keyword.toLowerCase().trim();
    if (!lowerKeyword) return `Error: Keyword is empty`;

    const candidates: Array<{ el: Element; score: number; selector: string }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node as HTMLElement;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;

      const text = el.textContent?.trim() || "";
      const ariaLabel = el.getAttribute("aria-label")?.trim() || "";
      const title = el.getAttribute("title")?.trim() || "";
      const alt = el.getAttribute("alt")?.trim() || "";
      const placeholder = el.getAttribute("placeholder")?.trim() || "";

      let score = 0;

      if (text.toLowerCase() === lowerKeyword) score += 100;
      else if (text.toLowerCase().includes(lowerKeyword)) score += 50;

      if (ariaLabel.toLowerCase() === lowerKeyword) score += 90;
      else if (ariaLabel.toLowerCase().includes(lowerKeyword)) score += 40;

      if (title.toLowerCase() === lowerKeyword) score += 80;
      else if (title.toLowerCase().includes(lowerKeyword)) score += 35;

      if (alt.toLowerCase() === lowerKeyword) score += 70;
      else if (alt.toLowerCase().includes(lowerKeyword)) score += 30;

      if (placeholder.toLowerCase() === lowerKeyword) score += 60;
      else if (placeholder.toLowerCase().includes(lowerKeyword)) score += 25;

      if (score > 0) {
        candidates.push({ el, score, selector: generateSelector(el) });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      return `Error: No element found matching "${keyword}"`;
    }

    const index = Math.max(1, Math.min(nth, candidates.length));
    const match = candidates[index - 1];
    const el = match.el as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const isClickable =
      el.onclick !== null ||
      tag === "button" ||
      tag === "a" ||
      el.getAttribute("role") === "button";

    return (
      `Found: selector="${match.selector}"\n` +
      `  tag=<${tag}>  text="${(el.textContent?.trim() || "").substring(0, 50)}"\n` +
      `  visible=true  clickable=${isClickable}\n` +
      `  position=(${Math.round(rect.x)}, ${Math.round(rect.y)})  size=${Math.round(rect.width)}x${Math.round(rect.height)}\n` +
      `  (match ${index}/${candidates.length}, score=${match.score})`
    );
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

function generateSelector(el: Element): string {
  if (el.id) return `#${el.id}`;

  const tag = el.tagName.toLowerCase();

  // 尝试用稳定的 class（过滤掉像 "_aB3cD4eF" 这种动态 hash）
  const stableClasses = Array.from(el.classList).filter(
    (c) => c.length < 20 && !/^[a-zA-Z0-9_]{10,}$/.test(c)
  );
  if (stableClasses.length > 0) {
    const classSelector = `${tag}.${stableClasses.join(".")}`;
    if (document.querySelectorAll(classSelector).length === 1) {
      return classSelector;
    }
  }

  // nth-child 路径
  const path: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.body) {
    const currentTag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) break;

    const siblings = Array.from(parent.children).filter(
      (s: Element) => s.tagName === current!.tagName
    );
    if (siblings.length > 1) {
      const idx = siblings.indexOf(current) + 1;
      path.unshift(`${currentTag}:nth-child(${idx})`);
    } else {
      path.unshift(currentTag);
    }
    current = parent;
  }

  return path.join(" > ");
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

  const payload = JSON.stringify({
    video_info: info,
    frames: frames.map((f) => ({
      time: f.time,
      data_url: f.dataUrl,
    })),
    frame_count: frames.length,
  });
  console.log(`[XHS Content] extract_video_frames done: ${frames.length} frames, payload size ${payload.length}`);
  return payload;
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
