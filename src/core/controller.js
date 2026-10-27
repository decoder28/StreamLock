/**
 * Universal Video Controller
 * Injected into the page execution context (Main World) to orchestrate video detection,
 * adapter binding, quality locking, and message communication.
 */

import {
  MSG_PAGE_SOURCE,
  MSG_CONTENT_SOURCE,
  ACTION_TYPES,
  DEFAULT_SETTINGS
} from "./constants.js";
import { CandidatePicker } from "./candidate-picker.js";
import { AdapterManager } from "./adapter-manager.js";
import { QualityManager } from "./quality-manager.js";
import { PlayerOverlay } from "../ui/player-overlay.js";

export class UniversalVideoController {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.adapterManager = new AdapterManager();
    this.overlay = new PlayerOverlay(this);
    this.lastStatusTime = 0;
    this.lastQualityLockCheck = 0;
    this.mutationObserver = null;
    this.intervalId = null;

    this.init();
  }

  init() {
    this.setupMessaging();
    this.setupDOMObserver();
    this.startLoop();
    this.tick();
    console.log("[UVC] Universal Video Quality & Buffer Controller initialized.");
  }

  setupMessaging() {
    window.addEventListener("message", event => {
      if (event.source !== window || !event.data || event.data.source !== MSG_CONTENT_SOURCE) {
        return;
      }

      const { type, settings, qualityKey, trackId, speed, requestId } = event.data;

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
          if (speed != null) {
            this.setSpeed(speed);
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

  setSpeed(rate) {
    const val = Number(rate);
    const clamped = (!Number.isFinite(val) || val <= 0) ? 1 : Math.round(Math.min(3.0, Math.max(0.1, val)) * 10) / 10;
    this.settings.speed = clamped;
    const adapter = this.getAdapter();
    if (adapter) {
      const video = adapter.getVideoElement();
      if (video) {
        video.playbackRate = clamped;
      }
    }
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

    // Verify current video is still in DOM
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

    // Apply buffer settings
    if (this.settings.enabled && adapter.supportsBufferControl()) {
      adapter.configureBuffer({
        buffer: this.settings.buffer,
        bufferEntireVideo: this.settings.bufferEntireVideo,
        liveMode: this.settings.liveMode || adapter.isLive()
      });
    }

    // Quality locking maintenance (every 3s)
    const now = Date.now();
    if (now - this.lastQualityLockCheck > 3000) {
      this.lastQualityLockCheck = now;
      this.enforceQualityLock(adapter);
    }

    // Send periodic status update every 2.5s
    if (now - this.lastStatusTime > 2500) {
      this.lastStatusTime = now;
      this.sendStatus();
    }
  }

  enforceQualityLock(adapter) {
    if (!this.settings.enabled || !adapter.supportsQualitySelection()) return;

    if (this.settings.mode === "quality" && this.settings.selectedQualityKey) {
      adapter.setQuality(this.settings.selectedQualityKey);
      return;
    }

    if (
      (this.settings.mode === "track" || this.settings.mode === "quality") &&
      this.settings.selectedTrackId !== null &&
      this.settings.selectedTrackId !== undefined
    ) {
      adapter.setQuality(
        this.settings.selectedQualityKey || this.settings.selectedTrackId
      );
      return;
    }

    if (this.settings.mode === "max") {
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
      abrEnabled: this.settings.mode === "auto",
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
}
