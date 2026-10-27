/**
 * hls.js Adapter
 * Supports HLS streaming via hls.js instance attached to HTML5 video.
 */

import { PlayerAdapter } from "./base-adapter.js";

export class HlsAdapter extends PlayerAdapter {
  constructor(videoElement, playerInstance = null, context = {}) {
    super(videoElement, playerInstance, context);
  }

  static detect(videoElement) {
    if (!(videoElement instanceof HTMLVideoElement)) return false;
    return !!HlsAdapter.findHlsInstance(videoElement);
  }

  static findHlsInstance(videoElement) {
    try {
      if (videoElement.__hls__) return videoElement.__hls__;
      if (videoElement._hls) return videoElement._hls;
      if (videoElement.hls) return videoElement.hls;
      if (window.hls && window.hls.media === videoElement) return window.hls;

      for (const key of Object.keys(window)) {
        try {
          const val = window[key];
          if (val && typeof val === "object" && val.levels && val.media === videoElement) {
            return val;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  getPlayer() {
    if (!this.player && this.video) {
      this.player = HlsAdapter.findHlsInstance(this.video);
    }
    return this.player;
  }

  getPlayerType() {
    return "hls.js";
  }

  getCapabilities() {
    const hls = this.getPlayer();
    const hasLevels = !!(hls && Array.isArray(hls.levels) && hls.levels.length > 0);
    return {
      qualitySelection: hasLevels,
      abrControl: hasLevels,
      bufferControl: !!hls,
      bitrate: hasLevels,
      liveDetection: true
    };
  }

  getQualities() {
    const hls = this.getPlayer();
    if (!hls || !Array.isArray(hls.levels)) return [];

    const activeIdx = hls.currentLevel;
    return hls.levels
      .map((level, idx) => {
        const height = level.height || 0;
        const width = level.width || (height ? Math.round(height * (16 / 9)) : 0);
        return {
          id: idx,
          index: idx,
          width: width,
          height: height,
          bitrate: level.bitrate || 0,
          label: height > 0 ? `${height}p` : `Level ${idx}`,
          codec: level.codecSet || level.attrs?.CODECS || null,
          fps: level.frameRate || null,
          source: "hls.js",
          active: activeIdx === idx
        };
      })
      .filter(q => q.height > 0 || q.bitrate > 0);
  }

  getCurrentQuality() {
    const qualities = this.getQualities();
    const hls = this.getPlayer();
    const currentIdx = hls ? hls.currentLevel : -1;
    const active = currentIdx >= 0 ? qualities.find(q => q.index === currentIdx) : null;
    const w = this.video ? this.video.videoWidth : 0;
    const h = this.video ? this.video.videoHeight : 0;

    return {
      width: active ? active.width : w,
      height: active ? active.height : h,
      bitrate: active ? active.bitrate : null,
      label: active ? active.label : (h > 0 ? `${h}p` : "—"),
      id: active ? active.id : null
    };
  }

  setQuality(qualityKey) {
    const hls = this.getPlayer();
    if (!hls || !Array.isArray(hls.levels)) return false;

    try {
      let targetIndex = -1;
      let maxBitrate = -1;

      for (let i = 0; i < hls.levels.length; i++) {
        const level = hls.levels[i];
        const width = level.width || (level.height ? Math.round(level.height * (16 / 9)) : 0);
        const key = `${width}x${level.height}`;
        if (
          key === String(qualityKey) ||
          String(level.height) === String(qualityKey) ||
          String(i) === String(qualityKey) ||
          String(qualityKey).endsWith("x" + level.height)
        ) {
          if ((level.bitrate || 0) >= maxBitrate) {
            maxBitrate = level.bitrate || 0;
            targetIndex = i;
          }
        }
      }

      if (targetIndex >= 0) {
        if (hls.currentLevel !== targetIndex) {
          hls.currentLevel = targetIndex;
          hls.loadLevel = targetIndex;
          console.log(`[UVC] hls.js locked to level ${targetIndex}`);
        }
        return true;
      }
    } catch (e) {
      console.debug("[UVC] hls.js setQuality failed:", e);
    }
    return false;
  }

  setAuto() {
    const hls = this.getPlayer();
    if (!hls) return false;
    try {
      if (hls.currentLevel !== -1) {
        hls.currentLevel = -1;
        hls.loadLevel = -1;
        console.log("[UVC] hls.js ABR Auto enabled");
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  setMax() {
    const hls = this.getPlayer();
    if (!hls || !Array.isArray(hls.levels)) return false;

    let bestIndex = 0;
    let maxH = -1;
    let maxB = -1;

    for (let i = 0; i < hls.levels.length; i++) {
      const h = hls.levels[i].height || 0;
      const b = hls.levels[i].bitrate || 0;
      if (h > maxH || (h === maxH && b > maxB)) {
        maxH = h;
        maxB = b;
        bestIndex = i;
      }
    }

    try {
      if (hls.currentLevel !== bestIndex) {
        hls.currentLevel = bestIndex;
        hls.loadLevel = bestIndex;
        console.log(`[UVC] hls.js Max Available locked to level ${bestIndex}`);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  getBitrate() {
    const hls = this.getPlayer();
    if (!hls || !Array.isArray(hls.levels)) return null;
    const idx = hls.currentLevel;
    if (idx >= 0 && hls.levels[idx]) {
      return hls.levels[idx].bitrate || null;
    }
    return null;
  }

  isLive() {
    const hls = this.getPlayer();
    if (hls && Array.isArray(hls.levels)) {
      const idx = hls.currentLevel >= 0 ? hls.currentLevel : 0;
      if (hls.levels[idx]?.details?.live) return true;
    }
    return super.isLive();
  }

  configureBuffer(settings) {
    const hls = this.getPlayer();
    if (!hls || !hls.config) return;

    const buffer = Number(settings.buffer) || 60;
    const isLiveStream = settings.liveMode || this.isLive();
    let targetBuffer = isLiveStream ? Math.min(buffer, 30) : buffer;

    if (settings && settings.bufferEntireVideo) {
      if (isLiveStream) {
        console.log("[StreamLock] Buffer Entire Video disabled for live content");
      } else if (this.video && Number.isFinite(this.video.duration) && this.video.duration > 0) {
        const remaining = Math.max(0, this.video.duration - (this.video.currentTime || 0));
        targetBuffer = Math.max(30, remaining + 30);
        console.log("[StreamLock] Buffer Entire Video ON (hls.js)");
        console.log("[StreamLock] Target maxBufferLength:", targetBuffer);
      }
    }

    try {
      hls.config.maxBufferLength = targetBuffer;
      hls.config.maxMaxBufferLength = targetBuffer * 2;
    } catch (e) {
      console.debug("[UVC] hls.js configureBuffer failed:", e);
    }
  }
}
