/**
 * Native HTML5 Video Adapter
 * Fallback for standard <video> elements where no custom streaming player library is exposed.
 */

import { PlayerAdapter } from "./base-adapter.js";

export class NativeVideoAdapter extends PlayerAdapter {
  constructor(videoElement, playerInstance = null, context = {}) {
    super(videoElement, playerInstance, context);
  }

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
    // Standard HTML5 video element with direct source does not expose selectable tracks.
    // Return empty array or single current indicator without faking alternatives.
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
