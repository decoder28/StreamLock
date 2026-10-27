/**
 * Site-Specific Adapter: JioHotstar
 * Discovers Shaka Player instance via Hotstar's player architecture
 * and extends ShakaAdapter for track/buffer/ABR controls.
 */

import { ShakaAdapter } from "../adapters/shaka-adapter.js";

export class HotstarAdapter extends ShakaAdapter {
  constructor(videoElement, playerInstance = null, context = {}) {
    super(videoElement, playerInstance, context);
  }

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
    } catch (e) {}
    return null;
  }

  static getHotstarShakaPlayer() {
    const inst = HotstarAdapter.getHotstarInstance();
    return inst ? (inst.shakaPlayer || inst._player) : null;
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
