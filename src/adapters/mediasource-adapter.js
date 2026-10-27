/**
 * Generic MediaSource Adapter
 * Handles video elements using MediaSource extensions (blob: URLs) where no high-level player API is exposed.
 */

import { PlayerAdapter } from "./base-adapter.js";

export class GenericMediaSourceAdapter extends PlayerAdapter {
  constructor(videoElement, playerInstance = null, context = {}) {
    super(videoElement, playerInstance, context);
  }

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

  setQuality() {
    return false;
  }

  setAuto() {
    return false;
  }

  setMax() {
    return false;
  }
}
