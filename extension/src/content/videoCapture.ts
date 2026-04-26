export interface VideoFrame {
  time: number;
  dataUrl: string;
}

/**
 * 查找视频元素。
 * 如果提供了 selector，直接 querySelector 查找；
 * 否则按面积取页面上最大的 video（兜底）。
 */
export function findMainVideo(selector?: string): HTMLVideoElement | null {
  if (selector) {
    const el = document.querySelector(selector);
    if (el instanceof HTMLVideoElement) return el;
    return null;
  }

  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];

  return videos.reduce((largest, v) => {
    const largestRect = largest.getBoundingClientRect();
    const vRect = v.getBoundingClientRect();
    return vRect.width * vRect.height > largestRect.width * largestRect.height
      ? v
      : largest;
  });
}

/**
 * 将视频 seek 到指定秒数，等待帧加载完成后 resolve。
 * 5 秒超时兜底，防止直播流或 DRM 视频永远 hang 住。
 */
export function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频 seek 失败"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      clearTimeout(timer);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("视频 seek 超时"));
    }, 5000);
    video.currentTime = Math.min(time, video.duration || time);
  });
}

/**
 * 对 video 元素当前画面截图，返回 base64 dataURL。
 * 限制尺寸和质量，避免消息传递/WebSocket 传输时数据量过大导致失败。
 */
export function captureVideoFrame(
  video: HTMLVideoElement,
  maxWidth = 640
): string {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maxWidth / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 canvas context");

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  // quality 0.6 足够 LLM 识别内容，同时大幅减少体积
  return canvas.toDataURL("image/jpeg", 0.6);
}

/**
 * 均匀抽帧：将视频按指定 interval（秒）截取多帧。
 */
export async function extractFrames(
  video: HTMLVideoElement,
  interval = 2.0
): Promise<VideoFrame[]> {
  const duration = video.duration;
  if (!duration || isNaN(duration) || !isFinite(duration)) {
    throw new Error("视频时长不可用");
  }

  // 限制最多抽 20 帧，避免数据量过大导致 chrome.tabs.sendMessage / WebSocket 传输失败
  const MAX_FRAMES = 20;
  const effectiveInterval = Math.max(interval, duration / MAX_FRAMES);

  const frames: VideoFrame[] = [];
  const originalTime = video.currentTime;
  const originalPaused = video.paused;

  // 先暂停，避免播放过程中抽帧混乱
  video.pause();

  try {
    for (let t = 0; t < duration && frames.length < MAX_FRAMES; t += effectiveInterval) {
      await seekTo(video, t);
      const dataUrl = captureVideoFrame(video);
      frames.push({ time: t, dataUrl });
    }
  } finally {
    // 恢复原状态
    try {
      await seekTo(video, originalTime);
    } catch {
      // 恢复失败不影响结果
    }
    if (!originalPaused) video.play();
  }

  return frames;
}

/**
 * 获取视频基本信息。
 */
export function getVideoInfo(video: HTMLVideoElement) {
  return {
    duration: video.duration,
    currentTime: video.currentTime,
    paused: video.paused,
    width: video.videoWidth,
    height: video.videoHeight,
    src: video.currentSrc || video.src,
  };
}
