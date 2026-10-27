/**
 * Video.js Adapter
 * Supports Video.js players and the qualityLevels plugin (VHS / HLS / DASH).
 */

import { PlayerAdapter } from "./base-adapter.js";

export class VideoJsAdapter extends PlayerAdapter {
  constructor(videoElement, playerInstance = null, context = {}) {
    super(videoElement, playerInstance, context);
  }

  static detect(videoElement) {
    if (!(videoElement instanceof HTMLVideoElement)) return false;
    const player = VideoJsAdapter.findPlayer(videoElement);
    return !!player;
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
      // qualityKey is expected to be "WIDTHxHEIGHT" e.g. "1280x720" or just height
      let targetIndex = -1;
      let maxBitrate = -1;

      for (let i = 0; i < ql.length; i++) {
        const level = ql[i];
        const key = `${level.width}x${level.height}`;
        if (key === String(qualityKey) || String(level.height) === String(qualityKey)) {
          if ((level.bitrate || 0) >= maxBitrate) {
            maxBitrate = level.bitrate || 0;
            targetIndex = i;
          }
        }
      }

      if (targetIndex >= 0) {
        for (let i = 0; i < ql.length; i++) {
          ql[i].enabled = (i === targetIndex);
        }
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
        ql[i].enabled = true;
      }
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
        ql[i].enabled = (i === bestIndex);
      }
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
