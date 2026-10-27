/**
 * Adapter Manager
 * Discovers the active player and manages adapter lifecycle according to priority.
 */

import { HotstarAdapter } from "../sites/hotstar-adapter.js";
import { ShakaAdapter } from "../adapters/shaka-adapter.js";
import { HlsAdapter } from "../adapters/hls-adapter.js";
import { VideoJsAdapter } from "../adapters/videojs-adapter.js";
import { GenericMediaSourceAdapter } from "../adapters/mediasource-adapter.js";
import { NativeVideoAdapter } from "../adapters/native-adapter.js";

export class AdapterManager {
  constructor() {
    this.currentAdapter = null;
    this.currentVideo = null;

    // Registry in strict priority order (most specific to least specific)
    this.adapterClasses = [
      HotstarAdapter,
      ShakaAdapter,
      HlsAdapter,
      VideoJsAdapter,
      GenericMediaSourceAdapter,
      NativeVideoAdapter
    ];
  }

  /**
   * Resolves the best adapter for the target video element.
   * @param {HTMLVideoElement} videoElement
   * @returns {PlayerAdapter|null}
   */
  resolveAdapter(videoElement) {
    if (!videoElement) return null;

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

  /**
   * Attaches an adapter to a video element if it changed or needs re-binding.
   * @param {HTMLVideoElement} videoElement
   * @returns {PlayerAdapter|null}
   */
  attach(videoElement) {
    if (!videoElement) {
      this.detach();
      return null;
    }

    // Check if current adapter is still valid for this video
    if (this.currentAdapter && this.currentVideo === videoElement) {
      // If current adapter is native or generic, check if a more specific player has initialized
      const isGeneric =
        this.currentAdapter instanceof NativeVideoAdapter ||
        this.currentAdapter instanceof GenericMediaSourceAdapter;

      if (!isGeneric) {
        return this.currentAdapter;
      }
    }

    const newAdapter = this.resolveAdapter(videoElement);
    if (!newAdapter) return null;

    // If new adapter is more specific or different, swap
    if (
      !this.currentAdapter ||
      this.currentVideo !== videoElement ||
      this.currentAdapter.getPlayerType() !== newAdapter.getPlayerType()
    ) {
      this.detach();
      this.currentAdapter = newAdapter;
      this.currentVideo = videoElement;
      console.log(`[UVC] Attached adapter: ${newAdapter.getPlayerType()}`);
    }

    return this.currentAdapter;
  }

  /**
   * Detaches and destroys current adapter.
   */
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
