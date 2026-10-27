/**
 * Base Player Adapter Interface
 * All video player technology adapters must extend this class or implement this interface.
 */

export class PlayerAdapter {
  constructor(videoElement, playerInstance = null, context = {}) {
    this.video = videoElement;
    this.player = playerInstance;
    this.context = context;
    this._destroyed = false;
  }

  /**
   * Static detection method: returns true if this adapter can control the given video element.
   * @param {HTMLVideoElement} videoElement
   * @param {Object} context
   * @returns {boolean}
   */
  static detect(videoElement, context = {}) {
    return false;
  }

  /**
   * Returns the underlying player instance if any.
   */
  getPlayer() {
    return this.player;
  }

  /**
   * Returns the attached HTMLVideoElement.
   */
  getVideoElement() {
    return this.video;
  }

  /**
   * Human-readable player technology name.
   */
  getPlayerType() {
    return "Unknown Player";
  }

  /**
   * Capability model. UI uses this to show/disable controls without faking functionality.
   * @returns {{
   *   qualitySelection: boolean,
   *   abrControl: boolean,
   *   bufferControl: boolean,
   *   bitrate: boolean,
   *   liveDetection: boolean
   * }}
   */
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

  /**
   * Returns normalized representation of all available video qualities.
   * Format: [
   *   {
   *     id: string|number,
   *     width: number,
   *     height: number,
   *     bitrate: number|null,
   *     label: string,
   *     codec?: string|null,
   *     fps?: number|null,
   *     source?: string,
   *     active?: boolean
   *   }
   * ]
   */
  getQualities() {
    return [];
  }

  /**
   * Returns current active representation info.
   */
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

  /**
   * Explicitly sets quality to a specific representation or resolution.
   * Disables ABR and locks the quality.
   * @param {string|number} qualityKeyOrId
   * @returns {boolean} success
   */
  setQuality(qualityKeyOrId) {
    return false;
  }

  /**
   * Enables Auto (Adaptive Bitrate Streaming) if supported.
   * @returns {boolean} success
   */
  setAuto() {
    return false;
  }

  /**
   * Selects highest available resolution, and highest bitrate variant within that resolution.
   * Disables ABR and locks quality.
   * @returns {boolean} success
   */
  setMax() {
    return false;
  }

  /**
   * Returns buffered seconds ahead of currentTime.
   */
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

  /**
   * Returns end timestamp of buffer ahead of currentTime.
   */
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

  /**
   * Comprehensive buffer diagnostics for performance analysis.
   */
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

  /**
   * Detects if current playback is a live stream.
   */
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

  /**
   * Returns current bitrate in bits per second, or null/0 if unavailable.
   */
  getBitrate() {
    return null;
  }

  /**
   * Configures buffer goal if supported.
   * @param {{ buffer: number, liveMode: boolean }} settings
   */
  configureBuffer(settings) {
    // Override in player adapters that expose buffer configuration
  }

  /**
   * Cleanup any attached listeners or references.
   */
  destroy() {
    this._destroyed = true;
    this.video = null;
    this.player = null;
    this.context = null;
  }
}
