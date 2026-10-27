/**
 * Universal Video Quality & Buffer Controller - Page Context Script (MAIN world)
 * Supports: JioHotstar (Shaka), Shaka Player, hls.js, Video.js, MediaSource, Native HTML5
 */

(() => {
  "use strict";

  if (window.__UNIVERSAL_VIDEO_CONTROLLER__ && typeof window.__UNIVERSAL_VIDEO_CONTROLLER__ === "object") {
    return;
  }

  // --- 1. CONSTANTS & MESSAGING PROTOCOL ---
  const MSG_PAGE_SOURCE = "UVC_PAGE";
  const MSG_CONTENT_SOURCE = "UVC_CONTENT";

  const ACTION_TYPES = {
    GET_STATUS: "GET_STATUS",
    STATUS: "STATUS",
    SET_SETTINGS: "SET_SETTINGS",
    SETTINGS_APPLIED: "SETTINGS_APPLIED",
    SELECT_QUALITY: "SELECT_QUALITY",
    SELECT_TRACK: "SELECT_TRACK",
    SELECT_MAX: "SELECT_MAX",
    SELECT_AUTO: "SELECT_AUTO",
    REFRESH_PLAYER: "REFRESH_PLAYER",
    SET_SPEED: "SET_SPEED"
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: "max", // 'auto' | 'max' | 'quality'
    selectedQualityKey: null,
    selectedTrackId: null,
    buffer: 60,
    bufferEntireVideo: false,
    liveMode: false,
    speed: 1.0,
    showPlayerOverlay: true
  };

  const AGGRESSIVE_BUFFER_CONFIG = {
    AGGRESSIVE_TARGET_BUFFER_S: 376,
    SEGMENT_PREFETCH_LIMIT: 5,
    PLATEAU_THRESHOLD_MS: 15000,
    STALL_THRESHOLD_MS: 10000,
    REFILL_CONFIRMATION_TICKS: 2,
    PEAK_ADAPT_TOLERANCE_S: 3,
    RECOVERY_COOLDOWN_MS: 30000,
    RECOVERY_VERIFY_TIMEOUT_MS: 10000,
    MAX_RECOVERY_ATTEMPTS: 2,
    END_OF_VOD_THRESHOLD_S: 15,
    SEEK_THRESHOLD_S: 15,
    SPEED_THRESHOLD: 1.2
  };

  // --- SPEED CLAMP ---
  const SPEED_MIN = 0.1;
  const SPEED_MAX = 3.0;
  function clampSpeed(val) {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, n)) * 10) / 10;
  }

  // --- 2. PLAYER FRAMEWORK AUTO-HOOKS (Early Interception) ---
  function setupFrameworkHooks() {
    try {
      // Hook Shaka Player attach method
      if (window.shaka?.Player?.prototype?.attach && !window.shaka.Player.prototype.__uvc_hooked__) {
        const origShakaAttach = window.shaka.Player.prototype.attach;
        window.shaka.Player.prototype.attach = function (mediaElement, ...args) {
          if (mediaElement instanceof HTMLVideoElement) {
            mediaElement.__shakaPlayer = this;
          }
          return origShakaAttach.apply(this, [mediaElement, ...args]);
        };
        window.shaka.Player.prototype.__uvc_hooked__ = true;
      }
    } catch (e) {}

    try {
      // Hook hls.js attachMedia method
      if (window.Hls?.prototype?.attachMedia && !window.Hls.prototype.__uvc_hooked__) {
        const origHlsAttach = window.Hls.prototype.attachMedia;
        window.Hls.prototype.attachMedia = function (mediaElement, ...args) {
          if (mediaElement instanceof HTMLVideoElement) {
            mediaElement.__hls__ = this;
          }
          return origHlsAttach.apply(this, [mediaElement, ...args]);
        };
        window.Hls.prototype.__uvc_hooked__ = true;
      }
    } catch (e) {}
  }

  setupFrameworkHooks();

  // --- 3. QUALITY UTILITIES ---
  class QualityManager {
    static groupQualities(tracks) {
      if (!Array.isArray(tracks) || !tracks.length) return [];

      const map = new Map();
      for (const track of tracks) {
        if (!track.height) continue;
        const width = track.width || Math.round(track.height * (16 / 9));
        const key = `${width}x${track.height}`;

        if (!map.has(key)) {
          map.set(key, []);
        }
        const b = track.bitrate || track.bandwidth || 0;
        map.get(key).push({
          ...track,
          width,
          bitrate: b,
          bandwidth: b
        });
      }

      const groups = [];
      for (const [key, variants] of map.entries()) {
        variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const best = variants[0];
        const hasActive = variants.some(v => v.active);

        groups.push({
          key,
          width: best.width,
          height: best.height,
          label: `${best.height}p`,
          maxBitrate: best.bitrate || 0,
          variants,
          active: hasActive
        });
      }

      groups.sort((a, b) => {
        if (b.height !== a.height) return b.height - a.height;
        return b.maxBitrate - a.maxBitrate;
      });

      return groups;
    }

    static getMaxAvailable(groups) {
      if (!groups || !groups.length) return null;
      return groups[0].variants?.[0] || null;
    }

    static formatBitrate(bitsPerSec) {
      if (!bitsPerSec || !Number.isFinite(bitsPerSec) || bitsPerSec <= 0) return "—";
      if (bitsPerSec >= 1000000) {
        return `${(bitsPerSec / 1000000).toFixed(2)} Mbps`;
      }
      return `${Math.round(bitsPerSec / 1000)} Kbps`;
    }
  }

  // --- 4. CANDIDATE VIDEO PICKER (Supports Light DOM & Shadow DOM) ---
  class CandidatePicker {
    static findAllVideos(root = document) {
      let videos = [];
      try {
        videos = Array.from(root.querySelectorAll("video"));
        const allElements = root.querySelectorAll("*");
        for (let i = 0; i < allElements.length; i++) {
          if (allElements[i].shadowRoot) {
            videos = videos.concat(CandidatePicker.findAllVideos(allElements[i].shadowRoot));
          }
        }
      } catch (e) {}
      return videos;
    }

    static pickBestVideo() {
      const videos = CandidatePicker.findAllVideos();
      if (!videos.length) {
        return { video: null, score: 0, candidates: [] };
      }

      if (videos.length === 1) {
        const v = videos[0];
        const score = CandidatePicker.scoreVideo(v);
        return { video: v, score, candidates: [{ video: v, score }] };
      }

      const scored = videos.map(video => ({
        video,
        score: CandidatePicker.scoreVideo(video)
      }));

      scored.sort((a, b) => b.score - a.score);

      return {
        video: scored[0]?.video || null,
        score: scored[0]?.score || 0,
        candidates: scored
      };
    }

    static scoreVideo(video) {
      if (!video || !(video instanceof HTMLVideoElement)) return -1000;
      let score = 0;

      try {
        const rect = video.getBoundingClientRect();
        const style = window.getComputedStyle(video);

        const isVisible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          parseFloat(style.opacity || "1") > 0.05 &&
          rect.width > 30 &&
          rect.height > 30;

        if (!isVisible) {
          score -= 500;
        } else {
          score += 100;
        }

        const renderedArea = rect.width * rect.height;
        score += Math.min(renderedArea / 5000, 300);

        if (video.videoWidth > 0 && video.videoHeight > 0) {
          score += 150;
          const intrinsicArea = video.videoWidth * video.videoHeight;
          score += Math.min(intrinsicArea / 10000, 200);
        }

        const isPlaying = !video.paused && !video.ended && video.readyState > 2;
        if (isPlaying) {
          score += 400;
        }

        if (Number.isFinite(video.duration) && video.duration > 30) {
          score += 100;
        } else if (video.duration === Infinity) {
          score += 200;
        }

        if (!video.muted && video.volume > 0) {
          score += 80;
        }

        if (video.currentTime > 1) {
          score += 50;
        }

        if (video.buffered && video.buffered.length > 0) {
          score += 50;
        }
      } catch (e) {
        score = 0;
      }

      return Math.round(score);
    }
  }

  // --- 5. BASE PLAYER ADAPTER ---
  class PlayerAdapter {
    constructor(videoElement, playerInstance = null, context = {}) {
      this.video = videoElement;
      this.player = playerInstance;
      this.context = context;
      this._destroyed = false;
    }

    static detect(videoElement, context = {}) {
      return false;
    }

    getPlayer() {
      return this.player;
    }

    getVideoElement() {
      return this.video;
    }

    getPlayerType() {
      return "Unknown Player";
    }

    getCapabilities() {
      return {
        qualitySelection: false,
        abrControl: false,
        bufferControl: false,
        bitrate: false,
        liveDetection: false
      };
    }

    supportsQualitySelection() {
      return this.getCapabilities().qualitySelection;
    }

    supportsBufferControl() {
      return this.getCapabilities().bufferControl;
    }

    getQualities() {
      return [];
    }

    getCurrentQuality() {
      if (!this.video) return null;
      return {
        width: this.video.videoWidth || 0,
        height: this.video.videoHeight || 0,
        bitrate: this.getBitrate() || null,
        label: this.video.videoHeight ? `${this.video.videoHeight}p` : "—",
        id: null
      };
    }

    setQuality(qualityKey) {
      return false;
    }

    setAuto() {
      return false;
    }

    setMax() {
      return false;
    }

    getBufferedSeconds() {
      if (!this.video || !this.video.buffered || !Number.isFinite(this.video.currentTime)) {
        return 0;
      }
      try {
        const ct = this.video.currentTime;
        for (let i = 0; i < this.video.buffered.length; i++) {
          if (ct >= this.video.buffered.start(i) && ct <= this.video.buffered.end(i)) {
            return Math.round((this.video.buffered.end(i) - ct) * 10) / 10;
          }
        }
      } catch (e) {}
      return 0;
    }

    getBufferedEnd() {
      if (!this.video || !this.video.buffered || !Number.isFinite(this.video.currentTime)) {
        return 0;
      }
      try {
        const ct = this.video.currentTime;
        for (let i = 0; i < this.video.buffered.length; i++) {
          if (ct >= this.video.buffered.start(i) && ct <= this.video.buffered.end(i)) {
            return Math.round(this.video.buffered.end(i) * 10) / 10;
          }
        }
        if (this.video.buffered.length > 0) {
          return Math.round(this.video.buffered.end(this.video.buffered.length - 1) * 10) / 10;
        }
      } catch (e) {}
      return 0;
    }

    getBufferDiagnostics() {
      const ct = this.getCurrentTime();
      const dur = this.getDuration();
      const bEnd = this.getBufferedEnd();
      const bAhead = this.getBufferedSeconds();

      const now = Date.now();
      let growthRate = 0;
      if (this._lastBufEndSample && this._lastBufEndSample.time > 0) {
        const dt = (now - this._lastBufEndSample.time) / 1000;
        if (dt >= 0.8) {
          const dEnd = bEnd - this._lastBufEndSample.end;
          growthRate = dEnd > 0 ? Math.round((dEnd / dt) * 10) / 10 : 0;
          this._lastGrowthRate = growthRate;
          this._lastBufEndSample = { end: bEnd, time: now };
        } else {
          growthRate = this._lastGrowthRate || 0;
        }
      } else {
        this._lastBufEndSample = { end: bEnd, time: now };
      }

      return {
        duration: dur,
        currentTime: ct,
        bufferedEnd: bEnd,
        bufferedAhead: bAhead,
        growthRate: growthRate,
        targetBufferingGoal: this._lastConfiguredGoal || null,
        actualBufferingGoal: typeof this.getBufferingGoal === "function" ? this.getBufferingGoal() : (this._lastConfiguredGoal || null),
        isAggressivePrebuffer: !!(this._lastConfiguredMode === "entire" && !this.isLive()),
        estimatedBandwidth: null,
        streamBandwidth: null,
        segmentPrefetchLimit: null,
        aggressiveState: "IDLE",
        learnedPeak: null,
        currentBuffer: bAhead,
        customRefillThreshold: null,
        recoveryCount: 0,
        lastRecoveryTime: 0
      };
    }

    getCurrentTime() {
      return this.video ? this.video.currentTime : 0;
    }

    getDuration() {
      return this.video ? this.video.duration : 0;
    }

    isLive() {
      if (!this.video) return false;
      if (this.video.duration === Infinity) return true;
      try {
        if (this.video.seekable && this.video.seekable.length > 0) {
          const span = this.video.seekable.end(0) - this.video.seekable.start(0);
          if (span > 86400 * 2) return true;
        }
      } catch (e) {}
      return false;
    }

    getBitrate() {
      return null;
    }

    configureBuffer(settings) {}

    destroy() {
      this._destroyed = true;
      this.video = null;
      this.player = null;
      this.context = null;
    }
  }

  // --- 6. NATIVE HTML5 ADAPTER ---
  class NativeVideoAdapter extends PlayerAdapter {
    static detect(videoElement) {
      return videoElement instanceof HTMLVideoElement;
    }

    getPlayerType() {
      return "Native HTML5";
    }

    getCapabilities() {
      return {
        qualitySelection: false,
        abrControl: false,
        bufferControl: false,
        bitrate: false,
        liveDetection: true
      };
    }

    getQualities() {
      return [];
    }

    getCurrentQuality() {
      if (!this.video) return null;
      const w = this.video.videoWidth || 0;
      const h = this.video.videoHeight || 0;
      return {
        width: w,
        height: h,
        bitrate: null,
        label: h > 0 ? `${h}p` : "—",
        id: "native-active"
      };
    }
  }

  // --- 7. GENERIC MEDIASOURCE ADAPTER ---
  class GenericMediaSourceAdapter extends PlayerAdapter {
    static detect(videoElement) {
      if (!(videoElement instanceof HTMLVideoElement)) return false;
      const src = videoElement.currentSrc || videoElement.src || "";
      return src.startsWith("blob:");
    }

    getPlayerType() {
      return "MediaSource (Generic)";
    }

    getCapabilities() {
      return {
        qualitySelection: false,
        abrControl: false,
        bufferControl: false,
        bitrate: false,
        liveDetection: true
      };
    }

    getQualities() {
      return [];
    }

    getCurrentQuality() {
      if (!this.video) return null;
      const w = this.video.videoWidth || 0;
      const h = this.video.videoHeight || 0;
      return {
        width: w,
        height: h,
        bitrate: null,
        label: h > 0 ? `${h}p` : "—",
        id: "mediasource-active"
      };
    }
  }

  // --- 8. VIDEO.JS ADAPTER ---
  class VideoJsAdapter extends PlayerAdapter {
    static detect(videoElement) {
      if (!(videoElement instanceof HTMLVideoElement)) return false;
      return !!VideoJsAdapter.findPlayer(videoElement);
    }

    static findPlayer(videoElement) {
      try {
        if (videoElement.player) return videoElement.player;
        if (typeof window.videojs === "function") {
          if (typeof window.videojs.getPlayer === "function") {
            const p = window.videojs.getPlayer(videoElement);
            if (p) return p;
          }
          if (window.videojs.players) {
            if (videoElement.id && window.videojs.players[videoElement.id]) {
              return window.videojs.players[videoElement.id];
            }
            const parent = videoElement.closest(".video-js");
            if (parent && parent.id && window.videojs.players[parent.id]) {
              return window.videojs.players[parent.id];
            }
          }
        }
      } catch (e) {}
      return null;
    }

    getPlayer() {
      if (!this.player && this.video) {
        this.player = VideoJsAdapter.findPlayer(this.video);
      }
      return this.player;
    }

    getPlayerType() {
      return "Video.js";
    }

    getQualityLevels() {
      const player = this.getPlayer();
      if (!player) return null;
      try {
        if (typeof player.qualityLevels === "function") {
          const ql = player.qualityLevels();
          if (ql && ql.length > 0) return ql;
        }
      } catch (e) {}
      return null;
    }

    getCapabilities() {
      const ql = this.getQualityLevels();
      const hasQualities = !!(ql && ql.length > 0);
      return {
        qualitySelection: hasQualities,
        abrControl: hasQualities,
        bufferControl: false,
        bitrate: hasQualities,
        liveDetection: true
      };
    }

    getQualities() {
      const ql = this.getQualityLevels();
      if (!ql || ql.length === 0) return [];

      const tracks = [];
      for (let i = 0; i < ql.length; i++) {
        const level = ql[i];
        if (level && level.height) {
          tracks.push({
            id: level.id || `level-${i}`,
            index: i,
            width: level.width || Math.round(level.height * (16 / 9)),
            height: level.height,
            bitrate: level.bitrate || 0,
            label: `${level.height}p`,
            codec: null,
            fps: null,
            source: "videojs",
            active: !!level.enabled
          });
        }
      }
      return tracks;
    }

    getCurrentQuality() {
      const qualities = this.getQualities();
      const active = qualities.find(q => q.active) || qualities[0];
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
      const ql = this.getQualityLevels();
      if (!ql || ql.length === 0) return false;

      try {
        let targetIndex = -1;
        let maxBitrate = -1;

        for (let i = 0; i < ql.length; i++) {
          const level = ql[i];
          const width = level.width || (level.height ? Math.round(level.height * (16 / 9)) : 0);
          const key = `${width}x${level.height}`;
          if (
            key === String(qualityKey) ||
            String(level.height) === String(qualityKey) ||
            String(qualityKey).endsWith("x" + level.height)
          ) {
            if ((level.bitrate || 0) >= maxBitrate) {
              maxBitrate = level.bitrate || 0;
              targetIndex = i;
            }
          }
        }

        if (targetIndex >= 0) {
          for (let i = 0; i < ql.length; i++) {
            const shouldEnable = (i === targetIndex);
            if (ql[i].enabled !== shouldEnable) {
              ql[i].enabled = shouldEnable;
            }
          }
          console.log(`[UVC] Video.js quality locked to level index ${targetIndex}`);
          return true;
        }
      } catch (e) {
        console.debug("[UVC] Video.js setQuality failed:", e);
      }
      return false;
    }

    setAuto() {
      const ql = this.getQualityLevels();
      if (!ql) return false;
      try {
        for (let i = 0; i < ql.length; i++) {
          if (!ql[i].enabled) {
            ql[i].enabled = true;
          }
        }
        console.log("[UVC] Video.js ABR Auto enabled");
        return true;
      } catch (e) {
        return false;
      }
    }

    setMax() {
      const ql = this.getQualityLevels();
      if (!ql || ql.length === 0) return false;

      let bestIndex = 0;
      let maxH = -1;
      let maxB = -1;

      for (let i = 0; i < ql.length; i++) {
        const h = ql[i].height || 0;
        const b = ql[i].bitrate || 0;
        if (h > maxH || (h === maxH && b > maxB)) {
          maxH = h;
          maxB = b;
          bestIndex = i;
        }
      }

      try {
        for (let i = 0; i < ql.length; i++) {
          const shouldEnable = (i === bestIndex);
          if (ql[i].enabled !== shouldEnable) {
            ql[i].enabled = shouldEnable;
          }
        }
        console.log(`[UVC] Video.js Max Available locked to level index ${bestIndex}`);
        return true;
      } catch (e) {
        return false;
      }
    }

    getBitrate() {
      const ql = this.getQualityLevels();
      if (ql && ql.selectedIndex != null && ql[ql.selectedIndex]) {
        return ql[ql.selectedIndex].bitrate || null;
      }
      return null;
    }
  }

  // --- 9. HLS.JS ADAPTER ---
  class HlsAdapter extends PlayerAdapter {
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
          // Avoid clearing buffer if already on target level
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

  // --- 10. SHAKA PLAYER ADAPTER ---
  class ShakaAdapter extends PlayerAdapter {
    constructor(videoElement, playerInstance = null, context = {}) {
      super(videoElement, playerInstance, context);

      this._aggressiveState = "IDLE";
      this._lastRecoveryTime = 0;
      this._recoveryCount = 0;
      this._lastMonitoredBufferedEnd = 0;
      this._needsRefillReconfigure = false;
      this._needsNormalReconfigure = false;
      this._lastConfiguredCurrentTime = 0;
      this._refillConfirmationTicks = 0;
      this._customRefillThreshold = null;
      this._lastConfiguredNormalGoal = null;
      this._currentStreamKey = null;
      this._lastPlaybackRate = 1;
      this._temporaryAggressiveActive = false;
      this._plateauStartTime = 0;
      this._preferredLanguage = null;
      this._preferredRoles = null;
      this._lastSeenShakaPref = null;
    }

    static detect(videoElement) {
      if (!(videoElement instanceof HTMLVideoElement)) return false;
      return !!ShakaAdapter.findShakaInstance(videoElement);
    }

    static findShakaInstance(videoElement) {
      try {
        if (videoElement.__shakaPlayer) {
          return videoElement.__shakaPlayer;
        }

        if (videoElement._shakaPlayer) {
          return videoElement._shakaPlayer;
        }

        if (
          videoElement.ui &&
          typeof videoElement.ui.getControls === "function"
        ) {
          const controls = videoElement.ui.getControls();

          if (
            controls &&
            typeof controls.getPlayer === "function"
          ) {
            const player = controls.getPlayer();

            if (player) {
              return player;
            }
          }
        }

        if (
          window.shakaPlayer &&
          typeof window.shakaPlayer.getVariantTracks === "function"
        ) {
          if (
            typeof window.shakaPlayer.getMediaElement === "function" &&
            window.shakaPlayer.getMediaElement() === videoElement
          ) {
            return window.shakaPlayer;
          }
        }

        if (
          window.player &&
          typeof window.player.getVariantTracks === "function"
        ) {
          if (
            typeof window.player.getMediaElement === "function" &&
            window.player.getMediaElement() === videoElement
          ) {
            return window.player;
          }
        }

        for (const key of Object.keys(window)) {
          try {
            const value = window[key];

            if (
              value &&
              typeof value === "object" &&
              typeof value.getVariantTracks === "function" &&
              typeof value.selectVariantTrack === "function"
            ) {
              if (
                typeof value.getMediaElement === "function" &&
                value.getMediaElement() === videoElement
              ) {
                return value;
              }
            }
          } catch (e) {}
        }
      } catch (e) {}

      return null;
    }

    getPlayer() {
      if (!this.player && this.video) {
        this.player =
          ShakaAdapter.findShakaInstance(this.video);
      }

      return this.player;
    }

    getPlayerType() {
      return "Shaka Player";
    }

    getCapabilities() {
      const player = this.getPlayer();

      return {
        qualitySelection:
          !!(
            player &&
            typeof player.getVariantTracks === "function"
          ),

        abrControl:
          !!(
            player &&
            typeof player.configure === "function"
          ),

        bufferControl:
          !!(
            player &&
            typeof player.configure === "function"
          ),

        bitrate: !!player,
        liveDetection: true
      };
    }

    getVariantTracks() {
      const player = this.getPlayer();

      if (
        !player ||
        typeof player.getVariantTracks !== "function"
      ) {
        return [];
      }

      try {
        return player
          .getVariantTracks()
          .filter(
            track =>
              track &&
              track.type === "variant" &&
              track.width &&
              track.height &&
              (track.bandwidth || track.bitrate)
          )
          .sort((a, b) => {
            if (b.height !== a.height) {
              return b.height - a.height;
            }

            return (
              (b.bandwidth || b.bitrate || 0) -
              (a.bandwidth || a.bitrate || 0)
            );
          });
      } catch (e) {
        return [];
      }
    }

    normalizeLanguage(lang) {
      if (!lang || typeof lang !== "string") return "";
      const clean = lang.trim().toLowerCase().split("-")[0].split("_")[0];
      const map = {
        hin: "hi",
        eng: "en",
        tam: "ta",
        tel: "te",
        kan: "kn",
        mal: "ml",
        ben: "bn",
        mar: "mr",
        guj: "gu",
        pan: "pa"
      };
      return map[clean] || clean;
    }

    languagesMatch(langA, langB) {
      const a = this.normalizeLanguage(langA);
      const b = this.normalizeLanguage(langB);
      return !!(a && b && a === b);
    }

    getTrackRoles(track) {
      if (!track) return [];
      if (Array.isArray(track.roles)) return track.roles;
      if (Array.isArray(track.audioRoles)) return track.audioRoles;
      return [];
    }

    isAudioDescription(track) {
      const roles = this.getTrackRoles(track);
      return roles.includes("description") || roles.includes("alt") || roles.includes("supplementary");
    }

    rolesMatch(trackRoles, preferredRoles) {
      const trackHasDesc = Array.isArray(trackRoles) &&
        (trackRoles.includes("description") || trackRoles.includes("alt") || trackRoles.includes("supplementary"));
      const prefHasDesc = Array.isArray(preferredRoles) &&
        (preferredRoles.includes("description") || preferredRoles.includes("alt") || preferredRoles.includes("supplementary"));
      return trackHasDesc === prefHasDesc;
    }

    getTrackLanguage(track) {
      if (!track) return null;

      return (
        track.language ||
        track.originalLanguage ||
        track.audioLanguage ||
        null
      );
    }

    getPreferredLanguage(tracks) {
      const player = this.getPlayer();
      let currentShakaPref = null;
      try {
        const pref = player?.getConfiguration?.()?.streaming?.preferredAudioLanguage;
        if (pref && typeof pref === "string" && pref.trim().length > 0) {
          currentShakaPref = this.normalizeLanguage(pref);
        }
      } catch (e) {}

      const active = tracks ? tracks.find(t => t.active) : null;
      const activeLang = active ? this.normalizeLanguage(this.getTrackLanguage(active)) : null;

      // First time observing Shaka config: establish baseline without falsely detecting a change
      if (this._lastSeenShakaPref === null) {
        this._lastSeenShakaPref = currentShakaPref || activeLang || null;
        if (activeLang) {
          this._preferredLanguage = activeLang;
          return this._preferredLanguage;
        }
        if (currentShakaPref) {
          this._preferredLanguage = currentShakaPref;
          return this._preferredLanguage;
        }
      } else if (currentShakaPref && currentShakaPref !== this._lastSeenShakaPref) {
        // Shaka configuration changed dynamically after baseline (user selected audio in player)
        this._lastSeenShakaPref = currentShakaPref;
        this._preferredLanguage = currentShakaPref;
        return this._preferredLanguage;
      }

      if (this._preferredLanguage) {
        return this._preferredLanguage;
      }

      if (activeLang) {
        this._preferredLanguage = activeLang;
        return this._preferredLanguage;
      }

      if (currentShakaPref) {
        this._preferredLanguage = currentShakaPref;
        return this._preferredLanguage;
      }

      // On startup when no track is active yet, inspect first non-description track
      if (tracks && tracks.length) {
        const primaryTrack = tracks.find(t => t.primary && !this.isAudioDescription(t)) ||
                             tracks.find(t => !this.isAudioDescription(t));
        if (primaryTrack) {
          const lang = this.getTrackLanguage(primaryTrack);
          if (lang) {
            this._preferredLanguage = this.normalizeLanguage(lang);
            return this._preferredLanguage;
          }
        }
      }

      return null;
    }

    getPreferredRoles(tracks) {
      if (this._preferredRoles !== null && this._preferredRoles !== undefined) {
        return this._preferredRoles;
      }
      const active = tracks ? tracks.find(t => t.active) : null;
      if (active) {
        this._preferredRoles = this.getTrackRoles(active);
        return this._preferredRoles;
      }
      return [];
    }

    getCurrentAudioLanguage() {
      const tracks = this.getVariantTracks();
      const active = tracks.find(track => track.active);
      if (!active) return this._preferredLanguage || null;
      return this.getTrackLanguage(active);
    }

    getAudioLanguages() {
      const tracks = this.getVariantTracks();
      const languages = new Map();

      for (const track of tracks) {
        const language = this.getTrackLanguage(track);
        if (!language) continue;

        if (!languages.has(language)) {
          languages.set(language, {
            code: language,
            label: track.label || language
          });
        }
      }

      return [...languages.values()];
    }

    normalizeTrack(track) {
      return {
        id: track.id,
        width: track.width,
        height: track.height,
        bitrate: track.bandwidth || track.bitrate || 0,
        label: `${track.height}p`,
        codec: track.codecs || null,
        fps: track.frameRate || null,

        language: this.getTrackLanguage(track),
        originalLanguage: track.originalLanguage || null,
        audioCodec: track.audioCodec || null,
        channelsCount: track.channelsCount || null,
        roles: this.getTrackRoles(track),

        source: "shaka",
        active: !!track.active
      };
    }

    getQualities() {
      const tracks = this.getVariantTracks();
      return tracks.map(track => this.normalizeTrack(track));
    }

    getCurrentQuality() {
      const tracks = this.getVariantTracks();

      const active = tracks.find(
        track => track.active
      );

      const width =
        this.video?.videoWidth || 0;

      const height =
        this.video?.videoHeight || 0;

      return {
        width:
          active?.width ||
          width,

        height:
          active?.height ||
          height,

        bitrate:
          active
            ? (
                active.bandwidth ||
                active.bitrate ||
                null
              )
            : null,

        label:
          active
            ? `${active.height}p`
            : (
                height > 0
                  ? `${height}p`
                  : "—"
              ),

        id:
          active
            ? active.id
            : null,

        language:
          active
            ? this.getTrackLanguage(active)
            : null
      };
    }

    resolveResolution(
      qualityKey,
      tracks
    ) {
      if (!tracks || !tracks.length || qualityKey == null) {
        return null;
      }

      const key = String(qualityKey).trim();

      const dimensionMatch =
        key.match(/^(\d+)x(\d+)$/);

      if (dimensionMatch) {
        return {
          width:
            Number(dimensionMatch[1]),
          height:
            Number(dimensionMatch[2])
        };
      }

      const pMatch =
        key.match(/^(\d+)p$/i);

      if (pMatch) {
        return this.resolveResolution(
          pMatch[1],
          tracks
        );
      }

      if (/^\d+$/.test(key)) {
        const height =
          Number(key);

        const candidates =
          tracks.filter(
            track =>
              Number(track.height) ===
              height
          );

        if (candidates.length) {
          const targetLang =
            this.getPreferredLanguage(tracks);

          let preferred =
            candidates;

          if (targetLang) {
            const sameLanguage =
              candidates.filter(
                track =>
                  this.languagesMatch(
                    this.getTrackLanguage(track),
                    targetLang
                  )
              );

            if (sameLanguage.length) {
              preferred =
                sameLanguage;
            }
          }

          return {
            width:
              preferred[0].width,
            height
          };
        }
      }

      const idTrack =
        tracks.find(
          track =>
            String(track.id) ===
            key
        );

      if (idTrack) {
        return {
          width:
            idTrack.width,
          height:
            idTrack.height
        };
      }

      return null;
    }

    findBestTrackForResolution(
      tracks,
      width,
      height
    ) {
      if (!tracks || !tracks.length) {
        return null;
      }

      let matching =
        tracks.filter(track => {
          return (
            Number(track.width) === Number(width) &&
            Number(track.height) === Number(height)
          );
        });

      if (!matching.length) {
        return null;
      }

      const targetLang =
        this.getPreferredLanguage(tracks);
      const targetRoles =
        this.getPreferredRoles(tracks);

      let candidates =
        matching;

      if (targetLang) {
        const sameLanguage =
          matching.filter(track => {
            return this.languagesMatch(
              this.getTrackLanguage(track),
              targetLang
            );
          });

        if (sameLanguage.length) {
          candidates =
            sameLanguage;
        }
      }

      const sameRole =
        candidates.filter(track => {
          return this.rolesMatch(
            this.getTrackRoles(track),
            targetRoles
          );
        });

      if (sameRole.length) {
        candidates =
          sameRole;
      } else {
        const nonDesc =
          candidates.filter(
            track =>
              !this.isAudioDescription(track)
          );
        if (nonDesc.length) {
          candidates =
            nonDesc;
        }
      }

      candidates.sort((a, b) => {
        const bRate =
          b.bandwidth || b.bitrate || 0;
        const aRate =
          a.bandwidth || a.bitrate || 0;
        return bRate - aRate;
      });

      return candidates[0] || null;
    }

    setQuality(qualityKey) {
      const player =
        this.getPlayer();

      if (!player) {
        return false;
      }

      const tracks =
        this.getVariantTracks();

      if (!tracks.length) {
        return false;
      }

      const resolution =
        this.resolveResolution(
          qualityKey,
          tracks
        );

      if (!resolution) {
        console.debug(
          "[UVC] Could not resolve quality:",
          qualityKey
        );

        return false;
      }

      const target =
        this.findBestTrackForResolution(
          tracks,
          resolution.width,
          resolution.height
        );

      if (!target) {
        console.debug(
          "[UVC] No track for resolution:",
          resolution
        );

        return false;
      }

      const active =
        tracks.find(
          track => track.active
        );

      const targetLanguage =
        this.getTrackLanguage(target);

      const activeLanguage =
        active
          ? this.getTrackLanguage(active)
          : null;

      const isResolutionAlreadyCorrect =
        active &&
        Number(active.width) === Number(resolution.width) &&
        Number(active.height) === Number(resolution.height);

      const preferredLang =
        this.getPreferredLanguage(tracks);

      const isAudioSwitchPending =
        preferredLang &&
        activeLanguage &&
        !this.languagesMatch(preferredLang, activeLanguage);

      if (isResolutionAlreadyCorrect) {
        if (isAudioSwitchPending) {
          console.log("[UVC] Audio switch in progress. Skipping variant re-selection to preserve user audio change.");
          return true;
        }
        if (active && String(active.id) === String(target.id)) {
          return true;
        }
        if (
          active &&
          this.languagesMatch(activeLanguage, targetLanguage) &&
          this.rolesMatch(this.getTrackRoles(active), this.getTrackRoles(target))
        ) {
          return true;
        }
      }

      try {
        player.configure({
          abr: {
            enabled: false
          }
        });

        if (
          !active ||
          String(active.id) !==
            String(target.id)
        ) {
          player.selectVariantTrack(
            target,
            true
          );

          if (this.languagesMatch(targetLanguage, preferredLang || targetLanguage)) {
            this._preferredLanguage = this.normalizeLanguage(targetLanguage);
            this._preferredRoles = this.getTrackRoles(target);
          }
        }

        console.log(
          "[UVC] QUALITY LOCK"
        );

        console.log(
          "[UVC] Requested:",
          qualityKey
        );

        console.log(
          "[UVC] Resolution:",
          `${target.width}x${target.height}`
        );

        console.log(
          "[UVC] Previous language:",
          activeLanguage
        );

        console.log(
          "[UVC] Current language:",
          targetLanguage
        );

        console.log(
          "[UVC] Roles:",
          target.roles || target.audioRoles || []
        );

        console.log(
          "[UVC] Track:",
          target.id
        );

        console.log(
          "[UVC] Bitrate:",
          target.bandwidth ||
            target.bitrate
        );

        console.log(
          "[UVC] ABR: disabled"
        );

        return true;

      } catch (e) {
        console.debug(
          "[UVC] Shaka setQuality failed:",
          e
        );

        return false;
      }
    }

    setAuto() {
      const player =
        this.getPlayer();

      if (!player) {
        return false;
      }

      try {
        player.configure({
          abr: {
            enabled: true
          }
        });

        console.log(
          "[UVC] Shaka ABR Auto enabled"
        );

        return true;

      } catch (e) {
        return false;
      }
    }

    setMax() {
      const player =
        this.getPlayer();

      if (!player) {
        return false;
      }

      const tracks =
        this.getVariantTracks();

      if (!tracks.length) {
        return false;
      }

      const active =
        tracks.find(
          track => track.active
        );

      const targetLang =
        this.getPreferredLanguage(tracks);

      const targetRoles =
        this.getPreferredRoles(tracks);

      let candidates =
        tracks;

      if (targetLang) {
        const sameLanguage =
          tracks.filter(
            track =>
              this.languagesMatch(
                this.getTrackLanguage(track),
                targetLang
              )
          );

        if (sameLanguage.length) {
          candidates =
            sameLanguage;
        }
      }

      const sameRole =
        candidates.filter(track => {
          return this.rolesMatch(
            this.getTrackRoles(track),
            targetRoles
          );
        });

      if (sameRole.length) {
        candidates =
          sameRole;
      } else {
        const nonDesc =
          candidates.filter(
            track =>
              !this.isAudioDescription(track)
          );
        if (nonDesc.length) {
          candidates =
            nonDesc;
        }
      }

      candidates.sort((a, b) => {
        if (b.height !== a.height) {
          return b.height - a.height;
        }

        return (
          (b.bandwidth || b.bitrate || 0) -
          (a.bandwidth || a.bitrate || 0)
        );
      });

      const target =
        candidates[0];

      if (!target) {
        return false;
      }

      const activeLang =
        active ? this.getTrackLanguage(active) : null;

      const isAudioSwitchPending =
        targetLang &&
        activeLang &&
        !this.languagesMatch(targetLang, activeLang);

      if (
        active &&
        Number(active.height) === Number(target.height) &&
        isAudioSwitchPending
      ) {
        console.log("[UVC] Max Available: Audio switch in progress. Preserving user audio change.");
        return true;
      }

      if (active && String(active.id) === String(target.id)) {
        return true;
      }

      try {
        player.configure({
          abr: {
            enabled: false
          }
        });

        player.selectVariantTrack(
          target,
          true
        );

        const targetLangResult =
          this.getTrackLanguage(target);

        if (this.languagesMatch(targetLangResult, targetLang || targetLangResult)) {
          this._preferredLanguage = this.normalizeLanguage(targetLangResult);
          this._preferredRoles = this.getTrackRoles(target);
        }

        console.log(
          "[UVC] MAX AVAILABLE"
        );

        console.log(
          "[UVC] Resolution:",
          `${target.width}x${target.height}`
        );

        console.log(
          "[UVC] Language:",
          targetLangResult
        );

        console.log(
          "[UVC] Roles:",
          target.roles || target.audioRoles || []
        );

        console.log(
          "[UVC] Track:",
          target.id
        );

        console.log(
          "[UVC] Bitrate:",
          target.bandwidth ||
            target.bitrate
        );

        return true;

      } catch (e) {
        console.debug(
          "[UVC] Shaka setMax failed:",
          e
        );

        return false;
      }
    }

    isLive() {
      const player =
        this.getPlayer();

      if (
        player &&
        typeof player.isLive ===
          "function"
      ) {
        try {
          return player.isLive();
        } catch (e) {}
      }

      return super.isLive();
    }

    getBitrate() {
      const current =
        this.getCurrentQuality();

      return current
        ? current.bitrate
        : null;
    }

    getBufferingGoal() {
      const player =
        this.getPlayer();

      if (
        !player ||
        typeof player.getConfiguration !==
          "function"
      ) {
        return null;
      }

      try {
        return (
          player
            .getConfiguration()
            ?.streaming
            ?.bufferingGoal ??
          null
        );
      } catch (e) {
        return null;
      }
    }

    /**
     * Resolves canonical stream identity to differentiate distinct media titles/assets.
     * @returns {string|null}
     */
    getStreamKey() {
      const player = this.getPlayer();
      if (player && typeof player.getAssetUri === "function") {
        const assetUri = player.getAssetUri();
        if (assetUri) return `shaka:${assetUri}`;
      }

      const duration = (this.video && Number.isFinite(this.video.duration) && this.video.duration > 0)
        ? (Math.round(this.video.duration * 10) / 10)
        : 0;
      const path = window.location.pathname || "";
      const src = this.video ? (this.video.currentSrc || this.video.src || "") : "";
      return `vod:${path}#${duration}#${src}`;
    }

    getBufferDiagnostics() {
      const base = super.getBufferDiagnostics();
      const player = this.getPlayer();

      let estimatedBw = null;
      let streamBw = null;
      let prefetchLimit = null;

      if (player) {
        try {
          if (typeof player.getStats === "function") {
            const stats = player.getStats();
            if (stats) {
              estimatedBw = stats.estimatedBandwidth || null;
              streamBw = stats.streamBandwidth || null;
            }
          }
          if (typeof player.getConfiguration === "function") {
            const cfg = player.getConfiguration();
            if (cfg?.streaming && "segmentPrefetchLimit" in cfg.streaming) {
              prefetchLimit = cfg.streaming.segmentPrefetchLimit;
            }
          }
        } catch (e) {}
      }

      const currentRate = (this.video && Number.isFinite(this.video.playbackRate))
        ? this.video.playbackRate
        : 1;

      const isAggressiveMode = !!(
        (this._lastConfiguredMode === "entire" ||
         this._lastConfiguredMode === "refill" ||
         this._lastConfiguredMode === "temp_aggressive") &&
        !this.isLive()
      );

      return {
        ...base,
        isAggressivePrebuffer: isAggressiveMode,
        estimatedBandwidth: estimatedBw,
        streamBandwidth: streamBw,
        segmentPrefetchLimit: prefetchLimit,
        aggressiveState: this._aggressiveState || "IDLE",
        learnedPeak: null,
        currentStreamKey: this._currentStreamKey || null,
        currentBuffer: base.bufferedAhead,
        customRefillThreshold: this._customRefillThreshold || null,
        targetBuffer: isAggressiveMode
          ? (AGGRESSIVE_BUFFER_CONFIG.AGGRESSIVE_TARGET_BUFFER_S || 376)
          : (this._lastConfiguredGoal || (AGGRESSIVE_BUFFER_CONFIG.AGGRESSIVE_TARGET_BUFFER_S || 376)),
        playbackRate: currentRate,
        recoveryCount: this._recoveryCount || 0,
        lastRecoveryTime: this._lastRecoveryTime || 0
      };
    }

    /**
     * Monitor buffer growth in aggressive VOD mode and manage state transitions:
     * IDLE -> FILLING -> (buffer >= 376s or end of VOD) -> NORMAL_BUFFERING -> (buffer <= custom) -> REFILLING -> FILLING
     */
    _updateAggressiveBufferState(video, player, now, settings) {
      if (!video || !player || this.isLive()) {
        this._aggressiveState = "IDLE";
        this._needsRefillReconfigure = false;
        this._needsNormalReconfigure = false;
        this._refillConfirmationTicks = 0;
        return;
      }

      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      if (duration <= 0) return;

      const bEnd = this.getBufferedEnd();
      const bAhead = this.getBufferedSeconds();
      const unbufferedRemaining = Math.max(0, duration - bEnd);
      const customBuffer = Number(settings?.buffer) || 60;
      this._customRefillThreshold = customBuffer;
      const aggressiveTarget = AGGRESSIVE_BUFFER_CONFIG.AGGRESSIVE_TARGET_BUFFER_S || 376;

      // Stream Identity Tracking: detect genuinely new media stream/episode/movie
      const streamKey = this.getStreamKey();
      if (streamKey && streamKey !== this._currentStreamKey) {
        console.log(`[StreamLock] New VOD stream detected (${streamKey}). Resetting buffer state for this stream.`);
        this._currentStreamKey = streamKey;
        this._refillConfirmationTicks = 0;
        this._aggressiveState = "FILLING";
        this._needsRefillReconfigure = true;
        this._lastMonitoredBufferedEnd = bEnd;
        this._plateauStartTime = 0;
      }

      // 1. If buffered to the end of the VOD timeline, flag complete
      if (unbufferedRemaining <= AGGRESSIVE_BUFFER_CONFIG.END_OF_VOD_THRESHOLD_S) {
        if (this._aggressiveState !== "COMPLETE") {
          console.log(`[StreamLock] Aggressive VOD prebuffer complete (${Math.round(bAhead)}s ahead, reached end of VOD).`);
        }
        this._aggressiveState = "COMPLETE";
        this._refillConfirmationTicks = 0;
        if (this._temporaryAggressiveActive) {
          this._temporaryAggressiveActive = false;
          this._needsNormalReconfigure = true;
        }
        return;
      }

      // Check if target buffer ceiling (~376s) has been reached
      if (bAhead >= aggressiveTarget) {
        if (this._aggressiveState === "FILLING" || this._aggressiveState === "REFILLING") {
          console.log(`[StreamLock] Reached target buffer ceiling (~${aggressiveTarget}s ahead, current: ${Math.round(bAhead)}s). Transitioning to NORMAL_BUFFERING.`);
          this._aggressiveState = "NORMAL_BUFFERING";
          this._needsNormalReconfigure = true;
          this._refillConfirmationTicks = 0;
          this._plateauStartTime = 0;
          if (this._temporaryAggressiveActive) {
            this._temporaryAggressiveActive = false;
          }
          return;
        }
      }

      const growthRate = this._lastGrowthRate || 0;
      const dEnd = bEnd - (this._lastMonitoredBufferedEnd || 0);

      // Initial state transition: if IDLE, start in FILLING
      if (this._aggressiveState === "IDLE") {
        this._aggressiveState = "FILLING";
        this._lastMonitoredBufferedEnd = bEnd;
        this._refillConfirmationTicks = 0;
        this._plateauStartTime = 0;
      }

      // 2. Growth tracking for FILLING & REFILLING
      if (this._aggressiveState === "FILLING" || this._aggressiveState === "REFILLING") {
        const isExpanding = (growthRate > 0.3 || dEnd > 0.5);

        if (isExpanding) {
          this._lastMonitoredBufferedEnd = bEnd;
          this._plateauStartTime = 0;
          if (this._aggressiveState === "REFILLING") {
            console.log(`[StreamLock] Aggressive refill growth active (+${growthRate}s/s, ${Math.round(bAhead)}s ahead). State: FILLING.`);
            this._aggressiveState = "FILLING";
          }
        } else {
          if (this._aggressiveState === "REFILLING") {
            this._aggressiveState = "FILLING";
          }

          // Keep last monitored end synchronized if eviction or minor backward movement occurs
          if (bEnd < (this._lastMonitoredBufferedEnd || 0)) {
            this._lastMonitoredBufferedEnd = bEnd;
          }

          // Sustained plateau/ceiling detection:
          // When physical/player buffering ceiling is reached (e.g. MSE quota limit or segment requests pause),
          // growthRate = 0 and dEnd = 0. We do not require reaching 376s to leave FILLING.
          // Require a sustained plateau across multiple monitoring intervals before exiting.
          if (!this._plateauStartTime) {
            this._plateauStartTime = now;
          } else {
            const plateauThreshold = AGGRESSIVE_BUFFER_CONFIG.PLATEAU_THRESHOLD_MS || 15000;
            if (now - this._plateauStartTime >= plateauThreshold) {
              console.log(
                `[StreamLock] Forward buffer reached sustained ceiling (~${Math.round(bAhead)}s ahead, target: ${aggressiveTarget}s, no growth for ${Math.round((now - this._plateauStartTime) / 1000)}s). Exiting FILLING -> NORMAL_BUFFERING.`
              );
              this._aggressiveState = "NORMAL_BUFFERING";
              this._needsNormalReconfigure = true;
              this._plateauStartTime = 0;
              this._refillConfirmationTicks = 0;
              if (this._temporaryAggressiveActive) {
                this._temporaryAggressiveActive = false;
              }
              return;
            }
          }
        }

        return;
      }

      // 3. Natural consumption in NORMAL_BUFFERING
      if (this._aggressiveState === "NORMAL_BUFFERING") {
        this._lastMonitoredBufferedEnd = bEnd;

        // Monitor when forward buffer drains down to the custom buffer threshold
        // NOTE: Stable or decreasing buffer is completely normal; does NOT require growth!
        if (bAhead <= customBuffer) {
          this._refillConfirmationTicks = (this._refillConfirmationTicks || 0) + 1;
          const requiredTicks = AGGRESSIVE_BUFFER_CONFIG.REFILL_CONFIRMATION_TICKS || 2;
          if (this._refillConfirmationTicks >= requiredTicks) {
            this._refillConfirmationTicks = 0;
            this._aggressiveState = "REFILLING";
            this._lastRecoveryTime = now;
            this._recoveryCount = (this._recoveryCount || 0) + 1;
            this._needsRefillReconfigure = true;
            this._lastMonitoredBufferedEnd = bEnd;
            this._plateauStartTime = 0;
            console.log(`[StreamLock] Buffer reached custom threshold (${Math.round(bAhead)}s <= ${customBuffer}s, confirmed across ${requiredTicks} ticks). Initiating REFILL toward ~${aggressiveTarget}s.`);
          }
        } else {
          this._refillConfirmationTicks = 0;
        }
      }
    }

    configureBuffer(settings) {
      const player =
        this.getPlayer();

      if (
        !player ||
        typeof player.configure !==
          "function"
      ) {
        return false;
      }

      const video = this.getVideoElement();
      const isLive = this.isLive();

      if (!video) {
        return false;
      }

      const now = (settings && typeof settings.now === "number") ? settings.now : Date.now();
      const customBuffer = Number(settings?.buffer) || 60;
      this._customRefillThreshold = customBuffer;

      const currentTime = Number.isFinite(video.currentTime) && video.currentTime > 0
        ? video.currentTime
        : 0;

      const currentRate = Number.isFinite(video.playbackRate) && video.playbackRate > 0
        ? video.playbackRate
        : 1;

      // Detect user seek (> SEEK_THRESHOLD_S, e.g. 15s)
      const lastCurTime = this._lastConfiguredCurrentTime || 0;
      const userSeekDetected = lastCurTime > 0 && Math.abs(currentTime - lastCurTime) > AGGRESSIVE_BUFFER_CONFIG.SEEK_THRESHOLD_S;
      if (userSeekDetected) {
        console.log(`[StreamLock] User seek detected (${Math.round(lastCurTime)}s -> ${Math.round(currentTime)}s). Entering aggressive filling.`);
        this._aggressiveState = "FILLING";
        this._refillConfirmationTicks = 0;
        this._needsRefillReconfigure = true;
        this._needsNormalReconfigure = false;
        this._lastMonitoredBufferedEnd = this.getBufferedEnd();
        this._lastConfiguredCurrentTime = currentTime;
        this._plateauStartTime = 0;
        if (!settings?.bufferEntireVideo) {
          this._temporaryAggressiveActive = true;
        }
      } else {
        this._lastConfiguredCurrentTime = currentTime;
      }

      // Detect playback speed changes
      const lastRate = this._lastPlaybackRate || 1;
      const speedIncreased = (currentRate > (AGGRESSIVE_BUFFER_CONFIG.SPEED_THRESHOLD || 1.2) && currentRate > lastRate);
      const speedDecreased = (currentRate <= 1.0 && lastRate > 1.0);
      this._lastPlaybackRate = currentRate;

      if (speedIncreased) {
        console.log(`[StreamLock] Playback speed increase detected (${lastRate}x -> ${currentRate}x). Entering aggressive filling.`);
        this._aggressiveState = "FILLING";
        this._refillConfirmationTicks = 0;
        this._needsRefillReconfigure = true;
        this._needsNormalReconfigure = false;
        this._lastMonitoredBufferedEnd = this.getBufferedEnd();
        this._plateauStartTime = 0;
        if (!settings?.bufferEntireVideo) {
          this._temporaryAggressiveActive = true;
        }
      } else if (speedDecreased && this._temporaryAggressiveActive) {
        console.log(`[StreamLock] Playback speed returned to ${currentRate}x. Returning to normal buffering.`);
        this._temporaryAggressiveActive = false;
        this._aggressiveState = "NORMAL_BUFFERING";
        this._needsNormalReconfigure = true;
      }

      // Determine if aggressive VOD buffering should be active
      const isEntireVideo = Boolean(settings?.bufferEntireVideo && !isLive);
      const isAggressiveActive = isEntireVideo || this._temporaryAggressiveActive;

      if (isAggressiveActive) {
        // 1. Update internal aggressive buffer state machine
        this._updateAggressiveBufferState(video, player, now, settings);

        // 2. Handle NORMAL_BUFFERING state (drain naturally toward customBuffer threshold)
        if (this._aggressiveState === "NORMAL_BUFFERING") {
          const modeChanged = this._lastConfiguredMode !== "normal_buffering";
          const needsNormal = this._needsNormalReconfigure;
          this._needsNormalReconfigure = false; // consume flag
          const customGoalChanged = this._lastConfiguredNormalGoal !== customBuffer;

          let shakaGoalOverwritten = false;
          try {
            const currentGoal = player.getConfiguration()?.streaming?.bufferingGoal;
            if (currentGoal != null && currentGoal !== customBuffer) {
              shakaGoalOverwritten = true;
            }
          } catch (e) {}

          const shouldConfigureNormal = modeChanged || needsNormal || customGoalChanged || shakaGoalOverwritten;
          if (!shouldConfigureNormal) {
            return true;
          }

          try {
            const normalCfg = {
              streaming: {
                bufferingGoal: customBuffer,
                rebufferingGoal: Math.min(30, customBuffer),
                bufferBehind: customBuffer,
                retryParameters: {
                  maxAttempts: 5,
                  baseDelay: 1000,
                  backoffFactor: 2
                }
              }
            };

            try {
              const currentConfig = player.getConfiguration();
              if (currentConfig?.streaming && "segmentPrefetchLimit" in currentConfig.streaming) {
                normalCfg.streaming.segmentPrefetchLimit = 0;
              }
            } catch (e) {}

            player.configure(normalCfg);
            this._lastConfiguredMode = "normal_buffering";
            this._lastConfiguredNormalGoal = customBuffer;
            this._lastConfiguredGoal = customBuffer;
            this._lastBufferConfigTime = now;

            console.log(`[StreamLock] Normal buffering active (Goal: ${customBuffer}s, prefetch: 0, consuming buffer naturally)`);
            return true;
          } catch (e) {
            console.debug("[StreamLock] Failed to configure normal buffering goal:", e);
            return false;
          }
        }

        // 3. Handle aggressive states: FILLING, REFILLING, COMPLETE
        const aggressiveTarget = AGGRESSIVE_BUFFER_CONFIG.AGGRESSIVE_TARGET_BUFFER_S || 376;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        const remaining = Math.max(0, duration - currentTime);
        const targetBuffer = (remaining > 0 && remaining < aggressiveTarget)
          ? Math.max(30, remaining)
          : aggressiveTarget;

        const modeChanged = (this._lastConfiguredMode !== "entire" && this._lastConfiguredMode !== "refill" && this._lastConfiguredMode !== "temp_aggressive");
        const needsRefill = this._needsRefillReconfigure;
        this._needsRefillReconfigure = false; // consume flag

        let shakaConfigChanged = false;
        try {
          const currentGoal = player.getConfiguration()?.streaming?.bufferingGoal;
          if (currentGoal != null && currentGoal !== targetBuffer) {
            shakaConfigChanged = true;
          }
        } catch (e) {}

        const shouldReconfigure = modeChanged || needsRefill || userSeekDetected || speedIncreased || shakaConfigChanged;
        if (!shouldReconfigure) {
          return true;
        }

        try {
          const config = {
            streaming: {
              bufferingGoal: targetBuffer,
              rebufferingGoal: Math.min(30, customBuffer, targetBuffer),
              bufferBehind: 30,
              retryParameters: {
                maxAttempts: 5,
                baseDelay: 1000,
                backoffFactor: 2
              }
            }
          };

          try {
            const currentConfig = player.getConfiguration();
            if (currentConfig?.streaming && "segmentPrefetchLimit" in currentConfig.streaming) {
              config.streaming.segmentPrefetchLimit = AGGRESSIVE_BUFFER_CONFIG.SEGMENT_PREFETCH_LIMIT || 5;
            }
          } catch (e) {}

          player.configure(config);

          this._lastConfiguredGoal = targetBuffer;
          this._lastConfiguredMode = this._temporaryAggressiveActive ? "temp_aggressive" : (needsRefill ? "refill" : "entire");
          this._lastBufferConfigTime = now;

          const actualGoal = this.getBufferingGoal();
          const reason = this._temporaryAggressiveActive
            ? (userSeekDetected ? "Seek Burst" : "Speed Burst")
            : (modeChanged ? "Initial ON" : (needsRefill ? "Controlled Refill" : "Seek Burst"));

          console.log(`[StreamLock] Aggressive VOD Prebuffer configured (Reason: ${reason}, State: ${this._aggressiveState}, Goal: ${targetBuffer}s, Actual: ${actualGoal}s, Prefetch: ${AGGRESSIVE_BUFFER_CONFIG.SEGMENT_PREFETCH_LIMIT || 5})`);

          return true;
        } catch (e) {
          console.debug("[StreamLock] Shaka configureBuffer (aggressive) failed:", e);
          return false;
        }
      }

      // Default PASSIVE Normal Buffer Mode (Entire Video = OFF and no active temporary aggressive burst)
      const buffer = customBuffer;
      const isLiveStream = !!settings?.liveMode || isLive;
      const effectiveGoal = isLiveStream ? Math.min(buffer, 30) : buffer;

      // Reset aggressive tracking state
      this._aggressiveState = "IDLE";
      this._refillConfirmationTicks = 0;
      this._needsRefillReconfigure = false;
      this._needsNormalReconfigure = false;
      this._temporaryAggressiveActive = false;

      if (
        this._lastConfiguredMode === "normal" &&
        this._lastConfiguredGoal === effectiveGoal &&
        now - (this._lastBufferConfigTime || 0) < 5000
      ) {
        return true;
      }

      try {
        const normalConfig = {
          streaming: {
            bufferingGoal: effectiveGoal,
            rebufferingGoal: isLiveStream ? 10 : Math.min(30, buffer),
            bufferBehind: effectiveGoal,
            retryParameters: {
              maxAttempts: 5,
              baseDelay: 1000,
              backoffFactor: 2
            }
          }
        };

        try {
          const currentConfig = player.getConfiguration();
          if (currentConfig?.streaming && "segmentPrefetchLimit" in currentConfig.streaming) {
            normalConfig.streaming.segmentPrefetchLimit = 0;
          }
        } catch (e) {}

        player.configure(normalConfig);

        this._lastConfiguredGoal = effectiveGoal;
        this._lastConfiguredMode = "normal";
        this._lastBufferConfigTime = now;

        const actualGoal = this.getBufferingGoal();
        console.log(`[StreamLock] Passive Normal Buffer configured (Goal: ${effectiveGoal}s, Actual: ${actualGoal}s, Prefetch: 0)`);

        return true;
      } catch (e) {
        console.debug("[StreamLock] Shaka configureBuffer failed:", e);
        return false;
      }
    }

    destroy() {
      this._lastConfiguredGoal = null;
      this._lastConfiguredMode = null;
      this._lastConfiguredNormalGoal = null;
      this._lastBufferConfigTime = 0;
      this._lastBufEndSample = null;
      this._lastGrowthRate = 0;
      this._aggressiveState = "IDLE";
      this._lastRecoveryTime = 0;
      this._recoveryCount = 0;
      this._lastMonitoredBufferedEnd = 0;
      this._needsRefillReconfigure = false;
      this._needsNormalReconfigure = false;
      this._lastConfiguredCurrentTime = 0;
      this._refillConfirmationTicks = 0;
      this._customRefillThreshold = null;
      this._currentStreamKey = null;
      this._lastPlaybackRate = 1;
      this._temporaryAggressiveActive = false;
      this._plateauStartTime = 0;
      this._preferredLanguage = null;
      this._preferredRoles = null;
      this._lastSeenShakaPref = null;
      super.destroy();
    }
  }

  // --- 11. JIOHOTSTAR SITE-SPECIFIC ADAPTER ---
  class HotstarAdapter extends ShakaAdapter {
    static isHotstarDomain() {
      try {
        const host = window.location.hostname || "";
        return host.includes("hotstar.com") || host.includes("jiohotstar.com");
      } catch (e) {
        return false;
      }
    }

    static getHotstarInstance() {
      try {
        if (window.HSPlayer?.injectError?._activeInstance) {
          return window.HSPlayer.injectError._activeInstance;
        }
        if (window.HSPlayer?._playerInstance) {
          return window.HSPlayer._playerInstance;
        }
        if (window.HSPlayer?.player) {
          return window.HSPlayer.player;
        }
        // Search HSPlayer properties
        if (window.HSPlayer && typeof window.HSPlayer === "object") {
          for (const k of Object.keys(window.HSPlayer)) {
            const item = window.HSPlayer[k];
            if (item && typeof item === "object") {
              if (item.shakaPlayer || item._shakaPlayer) return item;
              if (typeof item.getVariantTracks === "function") return item;
            }
          }
        }
      } catch (e) {}
      return null;
    }

    static getHotstarShakaPlayer() {
      const inst = HotstarAdapter.getHotstarInstance();
      if (!inst) return null;
      if (inst.shakaPlayer) return inst.shakaPlayer;
      if (inst._player) return inst._player;
      if (typeof inst.getVariantTracks === "function") return inst;
      return null;
    }

    static detect(videoElement) {
      if (!(videoElement instanceof HTMLVideoElement)) return false;
      if (!HotstarAdapter.isHotstarDomain()) return false;
      const player = HotstarAdapter.getHotstarShakaPlayer();
      return !!player;
    }

    getPlayer() {
      if (!this.player) {
        this.player = HotstarAdapter.getHotstarShakaPlayer();
      }
      return this.player;
    }

    getVideoElement() {
      if (!this.video) {
        const inst = HotstarAdapter.getHotstarInstance();
        if (inst && typeof inst.getMediaElement === "function") {
          this.video = inst.getMediaElement();
        }
      }
      return this.video;
    }

    getPlayerType() {
      return "JioHotstar (Shaka)";
    }
  }

  // --- 12. ADAPTER MANAGER ---
  class AdapterManager {
    constructor() {
      this.currentAdapter = null;
      this.currentVideo = null;
      this.adapterClasses = [
        HotstarAdapter,
        ShakaAdapter,
        HlsAdapter,
        VideoJsAdapter,
        GenericMediaSourceAdapter,
        NativeVideoAdapter
      ];
    }

    resolveAdapter(videoElement) {
      if (!videoElement) return null;
      setupFrameworkHooks();
      for (const AdapterCls of this.adapterClasses) {
        try {
          if (AdapterCls.detect(videoElement)) {
            return new AdapterCls(videoElement);
          }
        } catch (e) {
          console.debug(`[UVC] Detection error in ${AdapterCls.name}:`, e);
        }
      }
      return null;
    }

    attach(videoElement) {
      if (!videoElement) {
        this.detach();
        return null;
      }

      if (this.currentAdapter && this.currentVideo === videoElement) {
        const isGeneric =
          this.currentAdapter instanceof NativeVideoAdapter ||
          this.currentAdapter instanceof GenericMediaSourceAdapter;

        if (!isGeneric) {
          return this.currentAdapter;
        }
      }

      const newAdapter = this.resolveAdapter(videoElement);
      if (!newAdapter) return null;

      if (
        !this.currentAdapter ||
        this.currentVideo !== videoElement ||
        this.currentAdapter.getPlayerType() !== newAdapter.getPlayerType()
      ) {
        this.detach();
        this.currentAdapter = newAdapter;
        this.currentVideo = videoElement;
        console.log(`[UVC] Player detected: ${newAdapter.getPlayerType()}`);
      }

      return this.currentAdapter;
    }

    detach() {
      if (this.currentAdapter) {
        try {
          this.currentAdapter.destroy();
        } catch (e) {}
        this.currentAdapter = null;
      }
      this.currentVideo = null;
    }

    getAdapter() {
      return this.currentAdapter;
    }
  }

  // --- 13. IN-PLAYER UI OVERLAY ---
/**
   * StreamLock In-Player UI Overlay
   * 
   * Attaches a sleek, non-intrusive control badge overlay directly
   * inside the video player container using CSS containing-block mechanics.
   * 
   * Architecture (inspired by Speed Increment reference):
   * - Container: Target player ancestor (position: relative)
   * - Overlay: Absolutely pinned inside the container (position: absolute)
   * - Native CSS + activity tracking handles hover across video and player controls.
   * - Deduplication via dataset flags and cleanup on player recreation.
   */

  class PlayerOverlay {
    constructor(controller = null) {
      this.controller = controller;
      this.visible = controller?.settings?.showPlayerOverlay !== false;
      this.currentVideo = null;
      this.currentContainer = null;
      this.currentRoot = null;
      this.overlayElement = null;
      this._stylesInjected = false;
      this._hideTimer = null;
      this._boundListeners = [];
    }

    /**
     * Injects overlay CSS into document.head once.
     */
    injectStyles() {
      if (this._stylesInjected || document.getElementById("streamlock-overlay-styles")) {
        this._stylesInjected = true;
        return;
      }

      try {
        const style = document.createElement("style");
        style.id = "streamlock-overlay-styles";
        style.textContent = `
          .streamlock-player-container {
            /* Established as CSS containing block without disrupting site layout */
          }

          .streamlock-overlay {
            position: absolute !important;
            top: 14px !important;
            right: 14px !important;
            z-index: 2147483647 !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            padding: 4px 8px !important;
            background: rgba(11, 15, 23, 0.85) !important;
            backdrop-filter: blur(8px) !important;
            -webkit-backdrop-filter: blur(8px) !important;
            border: 1px solid rgba(255, 255, 255, 0.14) !important;
            border-radius: 6px !important;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45) !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
            font-size: 11px !important;
            line-height: 1 !important;
            color: #f1f5f9 !important;
            user-select: none !important;
            -webkit-user-select: none !important;
            pointer-events: auto !important;
            opacity: 0 !important;
            transform: translateY(-2px) !important;
            transition: opacity 0.25s ease, transform 0.25s ease !important;
          }

          /* Show overlay when player root or container is hovered, or when overlay itself is hovered/active */
          .streamlock-player-root:hover .streamlock-overlay,
          .streamlock-player-container:hover .streamlock-overlay,
          #video-container:hover .streamlock-overlay,
          [data-testid="player-container"]:hover .streamlock-overlay,
          .shaka-video-container:hover .streamlock-overlay,
          .player-container:hover .streamlock-overlay,
          .streamlock-overlay:hover,
          .streamlock-overlay.sl-visible {
            opacity: 1 !important;
            transform: translateY(0) !important;
            pointer-events: auto !important;
          }

          /* Completely hide overlay when visibility is toggled OFF */
          .streamlock-overlay.sl-hidden,
          .streamlock-player-root:hover .streamlock-overlay.sl-hidden,
          .streamlock-player-container:hover .streamlock-overlay.sl-hidden,
          #video-container:hover .streamlock-overlay.sl-hidden,
          [data-testid="player-container"]:hover .streamlock-overlay.sl-hidden,
          .shaka-video-container:hover .streamlock-overlay.sl-hidden,
          .player-container:hover .streamlock-overlay.sl-hidden,
          .streamlock-overlay.sl-hidden:hover,
          .streamlock-overlay.sl-hidden.sl-visible {
            display: none !important;
            opacity: 0 !important;
            pointer-events: none !important;
            visibility: hidden !important;
          }

          /* Allow clicks through transparent player click-shields */
          .streamlock-player-container.streamlock-controls-active,
          .streamlock-player-root.streamlock-controls-active {
            pointer-events: auto !important;
          }

          .sl-brand {
            display: inline-flex !important;
            align-items: center !important;
            gap: 3px !important;
            font-weight: 700 !important;
            font-size: 10px !important;
            letter-spacing: 0.5px !important;
            color: #38bdf8 !important;
            padding-right: 4px !important;
            border-right: 1px solid rgba(255, 255, 255, 0.12) !important;
            cursor: pointer !important;
            user-select: none !important;
          }

          .sl-btn {
            background: rgba(30, 41, 59, 0.7) !important;
            color: #e2e8f0 !important;
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            border-radius: 4px !important;
            padding: 3px 6px !important;
            font-size: 10px !important;
            font-weight: 600 !important;
            cursor: pointer !important;
            outline: none !important;
            line-height: 1 !important;
            pointer-events: auto !important;
            transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease !important;
          }

          .sl-btn:hover {
            background: rgba(51, 65, 85, 0.9) !important;
            border-color: #38bdf8 !important;
            color: #ffffff !important;
          }

          .sl-btn.sl-active {
            background: #16a34a !important;
            border-color: #22c55e !important;
            color: #ffffff !important;
          }

          .sl-pill {
            font-size: 10px !important;
            color: #94a3b8 !important;
            padding: 2px 4px !important;
            font-variant-numeric: tabular-nums !important;
          }

          .sl-pill strong {
            color: #f1f5f9 !important;
            font-weight: 600 !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
        this._stylesInjected = true;
      } catch (e) {
        console.debug("[StreamLock] Failed to inject overlay styles:", e);
      }
    }

    /**
     * Discovers the visual player container for the given <video> element.
     * Prioritizes platform-known player containers (e.g. Hotstar, Shaka, YouTube, Video.js),
     * then walks upward inspecting rendered geometry to find the real player viewport.
     * 
     * @param {HTMLVideoElement} video 
     * @returns {HTMLElement|null}
     */
    findPlayerContainer(video) {
      if (!video || !(video instanceof HTMLVideoElement)) return null;

      // 1. Check known player container selectors (Hotstar, Shaka, HTML5, Video.js, etc.)
      const playerSelectors = [
        '[data-testid="player-container"]',
        '.shaka-video-container',
        '.player-container',
        '.video-player',
        '.html5-video-player',
        '.vjs-tech',
        '.jwplayer',
        '.bmpui-ui-watermark-provider',
        '[data-player-container]',
        '.player-wrapper'
      ];

      for (const sel of playerSelectors) {
        try {
          const match = video.closest(sel);
          if (match) {
            return match.classList.contains("vjs-tech") ? match.parentElement : match;
          }
        } catch (e) {}
      }

      // 2. Safe ancestor walk: look up to 4 levels for a well-sized container
      let current = video.parentElement;
      let bestContainer = current;
      let depth = 0;

      try {
        while (current && current !== document.body && current !== document.documentElement && depth < 4) {
          const rect = current.getBoundingClientRect();
          if (rect.width >= 120 && rect.height >= 80) {
            bestContainer = current;
            const style = window.getComputedStyle(current);
            if (
              style.position === "relative" ||
              style.position === "absolute" ||
              /player|video|media|watch/i.test(current.className || "")
            ) {
              return current;
            }
          }
          current = current.parentElement;
          depth++;
        }
      } catch (e) {}

      return bestContainer || video.parentElement || video.parentNode || null;
    }

    /**
     * Finds the overarching player root that encapsulates the video,
     * player controls (playback bar, seekbar), and click shields.
     * 
     * @param {HTMLVideoElement} video 
     * @param {HTMLElement} container 
     * @returns {HTMLElement|null}
     */
    findPlayerRoot(video, container) {
      if (!video && !container) return null;
      const base = container || video;

      const known = base.closest(
        '[data-testid="player-container"], .shaka-video-container, .player-container, .video-player, [data-player-container], .player-wrapper, #player, .watch-video'
      );
      if (known && known !== container) {
        return known;
      }

      let curr = container ? container.parentElement : (video ? video.parentElement : null);
      let depth = 0;
      while (curr && curr !== document.body && curr !== document.documentElement && depth < 4) {
        const cls = typeof curr.className === "string" ? curr.className : "";
        const id = typeof curr.id === "string" ? curr.id : "";
        if (/player|video|media|watch|stage/i.test(cls) || /player|video|watch/i.test(id)) {
          return curr;
        }
        curr = curr.parentElement;
        depth++;
      }

      return container ? (container.parentElement || container) : null;
    }

    /**
     * Attaches the overlay to the player container of the target video.
     * 
     * @param {HTMLVideoElement} video 
     * @param {object} controller 
     */
    attach(video, controller = null) {
      if (controller) this.controller = controller;
      if (this.controller?.settings && typeof this.controller.settings.showPlayerOverlay === "boolean") {
        this.visible = this.controller.settings.showPlayerOverlay;
      }
      if (!video || !(video instanceof HTMLVideoElement)) return;

      // If already attached to this video and overlay is still in DOM, just re-verify
      if (
        this.currentVideo === video &&
        this.overlayElement &&
        document.contains(this.overlayElement)
      ) {
        return;
      }

      // If video changed, detach old overlay
      if (this.currentVideo && this.currentVideo !== video) {
        this.detach();
      }

      const container = this.findPlayerContainer(video);
      if (!container) return;

      const root = this.findPlayerRoot(video, container) || container;
      this.currentRoot = root;

      this.injectStyles();

      // Establish positioning context on the player container
      try {
        const compPos = window.getComputedStyle(container).position;
        if (compPos === "static" || compPos === "unset" || !compPos) {
          container.style.position = "relative";
        }
        container.classList.add("streamlock-player-container");
        if (root && root !== container) {
          root.classList.add("streamlock-player-root");
        }
      } catch (e) {}

      // Deduplication: remove any orphaned overlay in this container
      const existing = container.querySelector(".streamlock-overlay");
      if (existing) {
        existing.remove();
      }

      // Create the overlay container
      const overlay = document.createElement("div");
      overlay.className = "streamlock-overlay";
      if (!this.visible) {
        overlay.classList.add("sl-hidden");
      }
      overlay.setAttribute("data-streamlock-overlay", "true");

      // Brand icon (Double click to turn off overlay)
      const brand = document.createElement("span");
      brand.className = "sl-brand";
      brand.textContent = "SL";
      brand.title = "StreamLock Active (Double-click to turn off)";
      brand.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
      };
      brand.ondblclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.setVisible(false);
        if (this.controller) {
          if (this.controller.settings) {
            this.controller.settings.showPlayerOverlay = false;
          }
          this.controller.applySettings();
          this.controller.sendStatus();
        }
      };
      overlay.appendChild(brand);

      // Quality button
      const qualityBtn = document.createElement("button");
      qualityBtn.className = "sl-btn sl-quality";
      qualityBtn.textContent = "—";
      qualityBtn.title = "Current Quality (Click to toggle Max/Auto)";
      qualityBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!this.controller) return;
        const curMode = this.controller.settings?.mode;
        if (curMode === "max") {
          this.controller.settings.mode = "auto";
          this.controller.applySettings();
        } else {
          this.controller.settings.mode = "max";
          this.controller.applySettings();
        }
        this.controller.sendStatus();
      };
      overlay.appendChild(qualityBtn);

      // Buffer stat pill
      const bufferPill = document.createElement("span");
      bufferPill.className = "sl-pill sl-buffer";
      bufferPill.innerHTML = `Buf: <strong>—</strong>`;
      bufferPill.title = "Current forward buffer ahead";
      overlay.appendChild(bufferPill);

      // Buffer Entire Video toggle button
      const bevBtn = document.createElement("button");
      bevBtn.className = "sl-btn sl-bev";
      bevBtn.textContent = "Entire: OFF";
      bevBtn.title = "Buffer Entire Video (VOD)";
      bevBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!this.controller) return;
        const current = !!this.controller.settings?.bufferEntireVideo;
        this.controller.settings.bufferEntireVideo = !current;
        this.controller.applySettings();
        this.controller.sendStatus();
      };
      overlay.appendChild(bevBtn);

      // Speed control button
      const speedBtn = document.createElement("button");
      speedBtn.className = "sl-btn sl-speed";
      speedBtn.textContent = "1.0x";
      speedBtn.title = "Playback Speed (Click to cycle)";
      speedBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!this.controller) return;
        const currentSpeed = this.controller.settings?.speed || 1;
        const presets = [1.0, 1.5, 2.0, 3.0];
        let nextIdx = 0;
        for (let i = 0; i < presets.length; i++) {
          if (Math.abs(presets[i] - currentSpeed) < 0.05) {
            nextIdx = (i + 1) % presets.length;
            break;
          }
        }
        this.controller.setSpeed(presets[nextIdx]);
        this.controller.sendStatus();
      };
      overlay.appendChild(speedBtn);

      // Hover & interaction listeners to guarantee visibility across video area,
      // Hotstar controls bar, and StreamLock controls.
      const show = () => {
        if (!this.visible) return;
        if (this.overlayElement) {
          this.overlayElement.classList.add("sl-visible");
        }
        if (this._hideTimer) {
          clearTimeout(this._hideTimer);
          this._hideTimer = null;
        }
      };

      const scheduleHide = (delay = 2500) => {
        if (this._hideTimer) clearTimeout(this._hideTimer);
        if (!this.visible) return;
        this._hideTimer = setTimeout(() => {
          if (
            this.overlayElement &&
            !this.overlayElement.matches(":hover") &&
            !(this.currentRoot && this.currentRoot.matches(":hover")) &&
            !(this.currentContainer && this.currentContainer.matches(":hover"))
          ) {
            this.overlayElement.classList.remove("sl-visible");
          }
        }, delay);
      };

      const onActivity = () => {
        if (!this.visible) return;
        show();
        scheduleHide(2500);
      };

      const onLeave = (e) => {
        if (e && e.relatedTarget && this.currentRoot && this.currentRoot.contains(e.relatedTarget)) {
          return;
        }
        if (this._hideTimer) clearTimeout(this._hideTimer);
        if (this.overlayElement && !this.overlayElement.matches(":hover")) {
          this.overlayElement.classList.remove("sl-visible");
        }
      };

      const addListener = (el, type, fn) => {
        if (!el || typeof el.addEventListener !== "function") return;
        el.addEventListener(type, fn, { passive: true });
        this._boundListeners.push({ el, type, fn });
      };

      if (root) {
        addListener(root, "mouseenter", onActivity);
        addListener(root, "mousemove", onActivity);
        addListener(root, "mouseleave", onLeave);
      }

      if (container && container !== root) {
        addListener(container, "mouseenter", onActivity);
        addListener(container, "mousemove", onActivity);
        addListener(container, "mouseleave", onLeave);
      }

      addListener(overlay, "mouseenter", () => {
        show();
        try {
          container.classList.add("streamlock-controls-active");
        } catch (e) {}
      });
      addListener(overlay, "mouseleave", () => {
        scheduleHide(1500);
        try {
          container.classList.remove("streamlock-controls-active");
        } catch (e) {}
      });

      // Mount overlay to the container
      try {
        container.appendChild(overlay);
        this.currentVideo = video;
        this.currentContainer = container;
        this.overlayElement = overlay;
        video.dataset.hasStreamlockOverlay = "true";
      } catch (e) {
        console.debug("[StreamLock] Failed to append overlay to container:", e);
      }
    }

    /**
     * Updates overlay elements with fresh player status.
     * 
     * @param {object} status 
     */
    update(status) {
      if (!this.overlayElement || !document.contains(this.overlayElement) || !status) {
        return;
      }

      try {
        // 1. Quality button
        const qBtn = this.overlayElement.querySelector(".sl-quality");
        if (qBtn) {
          if (!status.capabilities?.qualitySelection) {
            qBtn.textContent = status.height ? `${status.height}p` : "Auto";
          } else if (status.mode === "auto") {
            qBtn.textContent = status.height ? `Auto (${status.height}p)` : "Auto";
          } else if (status.mode === "max") {
            qBtn.textContent = status.height ? `Max (${status.height}p)` : "Max";
          } else if (status.height) {
            qBtn.textContent = `${status.height}p`;
          } else {
            qBtn.textContent = "Auto";
          }
        }

        // 2. Buffer stat pill
        const bPill = this.overlayElement.querySelector(".sl-buffer");
        if (bPill) {
          const bAhead = Math.round(status.buffered || status.currentBuffer || 0);
          bPill.innerHTML = `Buf: <strong>${bAhead}s</strong>`;
        }

        // 3. Buffer Entire Video button
        const bevBtn = this.overlayElement.querySelector(".sl-bev");
        if (bevBtn) {
          if (status.isLive) {
            bevBtn.textContent = "Live";
            bevBtn.disabled = true;
            bevBtn.classList.remove("sl-active");
          } else if (status.bufferEntireVideo) {
            bevBtn.disabled = false;
            bevBtn.classList.add("sl-active");
            const state = status.aggressiveState && status.aggressiveState !== "IDLE"
              ? status.aggressiveState
              : "ON";
            bevBtn.textContent = `Entire: ${state}`;
            const targetGoal = status.actualBufferingGoal || 376;
            const refillGoal = status.customRefillThreshold || status.bufferSetting || 60;
            bevBtn.title = `Buffer Entire Video: ${state} (Target: ${targetGoal}s, Refill: ${refillGoal}s)`;
          } else {
            bevBtn.disabled = false;
            bevBtn.classList.remove("sl-active");
            bevBtn.textContent = "Entire: OFF";
            bevBtn.title = "Buffer Entire Video: OFF";
          }
        }

        // 4. Speed button
        const spdBtn = this.overlayElement.querySelector(".sl-speed");
        if (spdBtn) {
          const currentSpeed = status.speed || 1;
          spdBtn.textContent = currentSpeed.toFixed(1) + "x";
          spdBtn.title = `Playback Speed: ${currentSpeed.toFixed(1)}x (Click to cycle)`;
        }
      } catch (e) {}
    }

    /**
     * Toggles visibility of the in-player overlay without detaching or destroying it.
     * 
     * @param {boolean} visible 
     */
    setVisible(visible) {
      this.visible = visible !== false;
      if (this._hideTimer) {
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
      }
      if (this.overlayElement) {
        if (this.visible) {
          this.overlayElement.classList.remove("sl-hidden");
          if (this.controller) {
            this.update(this.controller.getStatus());
          }
        } else {
          this.overlayElement.classList.remove("sl-visible");
          this.overlayElement.classList.add("sl-hidden");
        }
      }
      if (!this.visible) {
        if (this.currentContainer) {
          try {
            this.currentContainer.classList.remove("streamlock-controls-active");
          } catch (e) {}
        }
        if (this.currentRoot) {
          try {
            this.currentRoot.classList.remove("streamlock-controls-active");
          } catch (e) {}
        }
      }
    }

    /**
     * Cleans up overlay from the DOM and clears references.
     */
    detach() {
      if (this._hideTimer) {
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
      }

      if (this._boundListeners) {
        for (const item of this._boundListeners) {
          try {
            item.el.removeEventListener(item.type, item.fn);
          } catch (e) {}
        }
        this._boundListeners = [];
      }

      if (this.overlayElement) {
        try {
          if (this.overlayElement.parentNode) {
            this.overlayElement.parentNode.removeChild(this.overlayElement);
          }
        } catch (e) {}
        this.overlayElement = null;
      }

      if (this.currentContainer) {
        try {
          this.currentContainer.classList.remove("streamlock-controls-active");
          this.currentContainer.classList.remove("streamlock-player-container");
        } catch (e) {}
        this.currentContainer = null;
      }

      if (this.currentRoot) {
        try {
          this.currentRoot.classList.remove("streamlock-player-root");
          this.currentRoot.classList.remove("streamlock-controls-active");
        } catch (e) {}
        this.currentRoot = null;
      }

      if (this.currentVideo) {
        try {
          delete this.currentVideo.dataset.hasStreamlockOverlay;
        } catch (e) {}
        this.currentVideo = null;
      }
    }
  }

  // --- 14. UNIVERSAL CONTROLLER CORE ---
  class UniversalVideoController {
    constructor() {
      this.settings = { ...DEFAULT_SETTINGS };
      this.adapterManager = new AdapterManager();
      this.overlay = new PlayerOverlay(this);
      this.lastStatusTime = 0;
      this.lastQualityLockCheck = 0;
      this.lastCandidates = [];
      this.mutationObserver = null;
      this.intervalId = null;

      this.init();
    }

    setSpeed(rate) {
      const clamped = clampSpeed(rate);
      this.settings.speed = clamped;
      const adapter = this.getAdapter();
      if (adapter) {
        const video = adapter.getVideoElement();
        if (video) {
          video.playbackRate = clamped;
        }
      }
    }

    init() {
      this.setupMessaging();
      this.setupDOMObserver();
      this.startLoop();
      this.tick();
      console.log("%c[UVC] Universal Video Quality & Buffer Controller active.", "color:#22c55e;font-weight:bold;");
    }

    setupMessaging() {
      window.addEventListener("message", event => {
        if (event.source !== window || !event.data || event.data.source !== MSG_CONTENT_SOURCE) {
          return;
        }

        const { type, settings, qualityKey, trackId, requestId } = event.data;

        switch (type) {
          case ACTION_TYPES.GET_STATUS:
            this.tick();
            this.sendStatus(requestId);
            break;

          case ACTION_TYPES.SET_SETTINGS:
            if (settings) {
              this.settings = { ...this.settings, ...settings };
            }
            this.applySettings();
            this.sendStatus(requestId, ACTION_TYPES.SETTINGS_APPLIED);
            break;

          case ACTION_TYPES.SELECT_TRACK: {
            const targetKey = qualityKey || trackId;
            if (targetKey !== undefined && targetKey !== null) {
              this.settings.mode = qualityKey ? "quality" : "track";
              if (qualityKey) this.settings.selectedQualityKey = qualityKey;
              if (trackId !== undefined && trackId !== null) this.settings.selectedTrackId = trackId;
              const adapter = this.getAdapter();
              if (adapter) {
                adapter.setQuality(targetKey);
              }
            }
            this.sendStatus(requestId, ACTION_TYPES.SETTINGS_APPLIED);
            break;
          }

          case ACTION_TYPES.SELECT_QUALITY:
            if (qualityKey) {
              this.settings.mode = "quality";
              this.settings.selectedQualityKey = qualityKey;
              const adapter = this.getAdapter();
              if (adapter) {
                adapter.setQuality(qualityKey);
              }
            }
            this.sendStatus(requestId, ACTION_TYPES.SETTINGS_APPLIED);
            break;

          case ACTION_TYPES.SELECT_MAX:
            this.settings.mode = "max";
            this.settings.selectedQualityKey = null;
            this.settings.selectedTrackId = null;
            {
              const adapter = this.getAdapter();
              if (adapter) {
                adapter.setMax();
              }
            }
            this.sendStatus(requestId, ACTION_TYPES.SETTINGS_APPLIED);
            break;

          case ACTION_TYPES.SELECT_AUTO:
            this.settings.mode = "auto";
            this.settings.selectedQualityKey = null;
            this.settings.selectedTrackId = null;
            {
              const adapter = this.getAdapter();
              if (adapter) {
                adapter.setAuto();
              }
            }
            this.sendStatus(requestId, ACTION_TYPES.SETTINGS_APPLIED);
            break;

          case ACTION_TYPES.SET_SPEED:
            if (event.data.speed != null) {
              this.setSpeed(event.data.speed);
            }
            this.sendStatus(requestId, ACTION_TYPES.SETTINGS_APPLIED);
            break;

          case ACTION_TYPES.REFRESH_PLAYER:
            this.adapterManager.detach();
            this.tick();
            this.sendStatus(requestId);
            break;
        }
      });
    }

    setupDOMObserver() {
      try {
        this.mutationObserver = new MutationObserver(mutations => {
          let videoChanged = false;
          for (const m of mutations) {
            if (m.type === "childList") {
              for (const node of m.addedNodes) {
                if (node.nodeName === "VIDEO" || (node.querySelector && node.querySelector("video"))) {
                  videoChanged = true;
                  break;
                }
              }
              if (videoChanged) break;
              for (const node of m.removedNodes) {
                if (node.nodeName === "VIDEO" || (node.querySelector && node.querySelector("video"))) {
                  videoChanged = true;
                  break;
                }
              }
              if (videoChanged) break;
            }
          }
          if (videoChanged) {
            this.tick();
          }
        });

        this.mutationObserver.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true
        });
      } catch (e) {
        console.debug("[UVC] MutationObserver error:", e);
      }
    }

    startLoop() {
      this.intervalId = setInterval(() => {
        this.tick();
      }, 1500);
    }

    tick() {
      const { video, score, candidates } = CandidatePicker.pickBestVideo();
      this.lastCandidates = candidates;

      if (!video) {
        this.adapterManager.detach();
        this.overlay.detach();
        return;
      }

      const currentVideo = this.adapterManager.currentVideo;
      if (currentVideo && !document.contains(currentVideo)) {
        this.adapterManager.detach();
        this.overlay.detach();
      }

      const adapter = this.adapterManager.attach(video);
      if (!adapter) {
        this.overlay.detach();
        return;
      }

      // Reapply stored speed to newly attached video (SPA/player recreation)
      if (this.settings.speed && this.settings.speed !== 1) {
        const activeVideo = adapter.getVideoElement();
        if (activeVideo && Math.abs(activeVideo.playbackRate - this.settings.speed) > 0.05) {
          activeVideo.playbackRate = this.settings.speed;
        }
      }

      // Synchronize in-player overlay
      if (this.settings.enabled) {
        this.overlay.attach(video, this);
        this.overlay.setVisible(this.settings.showPlayerOverlay !== false);
        this.overlay.update(this.getStatus());
      } else {
        this.overlay.detach();
      }

      if (this.settings.enabled && adapter.supportsBufferControl()) {
        adapter.configureBuffer({
          buffer: this.settings.buffer,
          bufferEntireVideo: this.settings.bufferEntireVideo,
          liveMode: this.settings.liveMode || adapter.isLive()
        });
      }

      const now = Date.now();
      if (now - this.lastQualityLockCheck > 3000) {
        this.lastQualityLockCheck = now;
        this.enforceQualityLock(adapter);
      }

      if (now - this.lastStatusTime > 2500) {
        this.lastStatusTime = now;
        this.sendStatus();
      }
    }

    enforceQualityLock(adapter) {
      if (
        !this.settings.enabled ||
        !adapter.supportsQualitySelection()
      ) {
        return;
      }

      /*
       * IMPORTANT:
       *
       * For Shaka/Hotstar we NEVER keep forcing
       * an old audio-specific track ID.
       *
       * We lock the RESOLUTION instead.
       *
       * This allows the user to change:
       *
       * Hindi → English
       *
       * from Hotstar's own audio selector.
       *
       * The extension then finds:
       *
       * English + same resolution
       */

      if (
        this.settings.mode === "quality" &&
        this.settings.selectedQualityKey
      ) {
        adapter.setQuality(
          this.settings.selectedQualityKey
        );

        return;
      }

      if (
        this.settings.mode === "track" &&
        this.settings.selectedTrackId !== null &&
        this.settings.selectedTrackId !== undefined
      ) {
        /*
         * OLD saved settings may still contain
         * selectedTrackId.
         *
         * Pass it only as a resolution reference.
         * ShakaAdapter resolves it against the
         * CURRENT audio language.
         */
        adapter.setQuality(
          this.settings.selectedQualityKey || this.settings.selectedTrackId
        );

        return;
      }

      if (
        this.settings.mode === "max"
      ) {
        /*
         * setMax() itself now preserves
         * the currently active audio language.
         */
        adapter.setMax();
      }
    }

    applySettings() {
      if (this.overlay) {
        this.overlay.setVisible(this.settings.showPlayerOverlay !== false);
      }

      const adapter = this.getAdapter();
      if (!adapter || !this.settings.enabled) return;

      if (adapter.supportsBufferControl()) {
        adapter.configureBuffer({
          buffer: this.settings.buffer,
          bufferEntireVideo: this.settings.bufferEntireVideo,
          liveMode: this.settings.liveMode && adapter.isLive()
        });
      }

      if (this.settings.mode === "auto") {
        adapter.setAuto();
      } else if (this.settings.mode === "max") {
        adapter.setMax();
      } else if (this.settings.mode === "track" && this.settings.selectedTrackId !== null && this.settings.selectedTrackId !== undefined) {
        adapter.setQuality(this.settings.selectedQualityKey || this.settings.selectedTrackId);
      } else if (this.settings.mode === "quality" && this.settings.selectedQualityKey) {
        adapter.setQuality(this.settings.selectedQualityKey);
      }
    }

    getAdapter() {
      return this.adapterManager.getAdapter();
    }

    getStatus() {
      const adapter = this.getAdapter();

      if (!adapter) {
        return {
          detected: false,
          enabled: this.settings.enabled,
          showPlayerOverlay: this.settings.showPlayerOverlay !== false,
          mode: this.settings.mode,
          selectedQualityKey: this.settings.selectedQualityKey,
          selectedTrackId: this.settings.selectedTrackId,
          bufferSetting: this.settings.buffer,
          bufferEntireVideo: !!this.settings.bufferEntireVideo,
          actualBufferingGoal: this.settings.buffer,
          liveMode: this.settings.liveMode,
          playerType: "None",
          capabilities: {
            qualitySelection: false,
            abrControl: false,
            bufferControl: false,
            bitrate: false,
            liveDetection: false
          },
          variants: [],
          allTracks: [],
          candidateCount: this.lastCandidates ? this.lastCandidates.length : 0,
          aggressiveState: "IDLE",
          learnedPeak: null,
          currentBuffer: 0,
          customRefillThreshold: this.settings ? this.settings.buffer : 120,
          recoveryCount: 0,
          lastRecoveryTime: 0,
          speed: this.settings.speed || 1
        };
      }

      const capabilities = adapter.getCapabilities();
      const rawTracks = adapter.getQualities();
      const groups = QualityManager.groupQualities(rawTracks);
      const currentQ = adapter.getCurrentQuality();
      const isLive = adapter.isLive();
      const buffered = adapter.getBufferedSeconds();
      const bitrate = adapter.getBitrate();
      const actualGoal = typeof adapter.getBufferingGoal === "function" ? adapter.getBufferingGoal() : this.settings.buffer;
      const diag = typeof adapter.getBufferDiagnostics === "function" ? adapter.getBufferDiagnostics() : null;

      let abrState = null;
      if (capabilities.abrControl) {
        abrState = this.settings.mode === "auto";
      }

      return {
        detected: true,
        enabled: this.settings.enabled,
        showPlayerOverlay: this.settings.showPlayerOverlay !== false,
        mode: this.settings.mode,
        selectedQualityKey: this.settings.selectedQualityKey,
        selectedTrackId: this.settings.selectedTrackId,
        bufferSetting: this.settings.buffer,
        bufferEntireVideo: !!this.settings.bufferEntireVideo,
        actualBufferingGoal: actualGoal,
        liveMode: this.settings.liveMode,
        isLive: isLive,
        playerType: adapter.getPlayerType(),
        capabilities: capabilities,
        width: currentQ ? currentQ.width : 0,
        height: currentQ ? currentQ.height : 0,
        bandwidth: (currentQ && currentQ.bitrate) ? currentQ.bitrate : (bitrate || 0),
        buffered: buffered,
        currentBuffer: buffered,
        bufferedEnd: diag ? diag.bufferedEnd : (typeof adapter.getBufferedEnd === "function" ? adapter.getBufferedEnd() : 0),
        duration: diag ? diag.duration : adapter.getDuration(),
        currentTime: diag ? diag.currentTime : adapter.getCurrentTime(),
        growthRate: diag ? diag.growthRate : 0,
        isAggressivePrebuffer: diag ? diag.isAggressivePrebuffer : false,
        estimatedBandwidth: diag ? diag.estimatedBandwidth : null,
        streamBandwidth: diag ? diag.streamBandwidth : null,
        segmentPrefetchLimit: diag ? diag.segmentPrefetchLimit : null,
        aggressiveState: diag ? diag.aggressiveState : "IDLE",
        learnedPeak: diag ? diag.learnedPeak : null,
        customRefillThreshold: diag && diag.customRefillThreshold != null
          ? diag.customRefillThreshold
          : (this.settings ? this.settings.buffer : 120),
        recoveryCount: diag ? diag.recoveryCount : 0,
        lastRecoveryTime: diag ? diag.lastRecoveryTime : 0,
        abrEnabled: abrState,
        variants: groups,
        allTracks: rawTracks,
        candidateCount: this.lastCandidates ? this.lastCandidates.length : 1,
        speed: adapter.getVideoElement()?.playbackRate || this.settings.speed || 1
      };
    }

    sendStatus(requestId = null, type = ACTION_TYPES.STATUS) {
      const status = this.getStatus();
      if (this.overlay) {
        this.overlay.update(status);
      }
      try {
        window.postMessage(
          {
            source: MSG_PAGE_SOURCE,
            type: type,
            requestId: requestId || null,
            status: status
          },
          "*"
        );
      } catch (e) {}
    }

    /**
     * Browser Console Debug Command
     * Call window.__UVC__.debug() to view full diagnostics table
     */
    debug() {
      const s = this.getStatus();
      const adapter = this.getAdapter();
      const video = adapter?.getVideoElement();

      console.group("%c[UVC DEBUG DIAGNOSTICS]", "color:#3b82f6;font-weight:bold;font-size:13px;");
      console.log("%cPlayer Status:", "font-weight:bold;", {
        detected: s.detected,
        playerType: s.playerType,
        streamMode: s.isLive ? "LIVE" : "VOD",
        currentResolution: `${s.width} × ${s.height}`,
        currentBitrate: QualityManager.formatBitrate(s.bandwidth),
        bufferedSeconds: `${s.buffered}s`,
        bufferedEnd: `${s.bufferedEnd || 0}s`,
        bufferEntireVideo: s.bufferEntireVideo ? "ON (Aggressive VOD Prebuffer)" : "OFF",
        aggressiveState: s.aggressiveState,
        recoveryCount: s.recoveryCount,
        bufferGrowthRate: s.growthRate > 0 ? `+${s.growthRate}s/s (${s.growthRate}x playback)` : "Idle",
        bufferingGoal: `${s.actualBufferingGoal}s`,
        estimatedBandwidth: s.estimatedBandwidth ? QualityManager.formatBitrate(s.estimatedBandwidth) : "N/A",
        segmentPrefetchLimit: s.segmentPrefetchLimit != null ? s.segmentPrefetchLimit : "Default (0)",
        abrState: s.abrEnabled === null ? "Unsupported" : (s.abrEnabled ? "ON" : "OFF"),
        activeMode: s.mode,
        lockedQuality: s.selectedQualityKey || "None"
      });

      console.log("%cCapabilities:", "font-weight:bold;", s.capabilities);

      console.log("%cVideo Element:", "font-weight:bold;", video ? {
        node: video,
        src: video.currentSrc || video.src,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused
      } : "None");

      console.log("%cGrouped Quality Options:", "font-weight:bold;");
      if (s.variants?.length) {
        console.table(s.variants.map(g => ({
          Resolution: g.label,
          MaxBitrate: QualityManager.formatBitrate(g.maxBitrate),
          VariantCount: g.variants.length,
          Active: g.active ? "YES" : "NO"
        })));
      } else {
        console.log("No selectable quality representations exposed.");
      }

      console.log("%cCandidate Videos Evaluated:", "font-weight:bold;", this.lastCandidates);
      console.groupEnd();

      return s;
    }
  }

  // Instantiate Universal Controller and expose to window for developer inspection
  const controllerInstance = new UniversalVideoController();
  window.__UNIVERSAL_VIDEO_CONTROLLER__ = controllerInstance;
  window.__UVC__ = controllerInstance;
})();
