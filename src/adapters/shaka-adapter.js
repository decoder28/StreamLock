/**
 * Generic Shaka Player Adapter
 * Quality locking with audio-language preservation.
 */

import { PlayerAdapter } from "./base-adapter.js";
import { AGGRESSIVE_BUFFER_CONFIG } from "../core/constants.js";

export class ShakaAdapter extends PlayerAdapter {
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
      if (videoElement.__shakaPlayer) return videoElement.__shakaPlayer;
      if (videoElement._shakaPlayer) return videoElement._shakaPlayer;

      if (
        videoElement.ui &&
        typeof videoElement.ui.getControls === "function"
      ) {
        const controls = videoElement.ui.getControls();

        if (controls && typeof controls.getPlayer === "function") {
          const player = controls.getPlayer();
          if (player) return player;
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
      this.player = ShakaAdapter.findShakaInstance(this.video);
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
        !!player &&
        typeof player.getVariantTracks === "function",

      abrControl:
        !!player &&
        typeof player.configure === "function",

      bufferControl:
        !!player &&
        typeof player.configure === "function",

      bitrate: !!player,
      liveDetection: true
    };
  }

  /**
   * Get all Shaka variants.
   */
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

  /**
   * Normalize Shaka language string.
   */
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

  /**
   * Check if two languages match semantically.
   */
  languagesMatch(langA, langB) {
    const a = this.normalizeLanguage(langA);
    const b = this.normalizeLanguage(langB);
    return !!(a && b && a === b);
  }

  /**
   * Extract audio roles for a track.
   */
  getTrackRoles(track) {
    if (!track) return [];
    if (Array.isArray(track.roles)) return track.roles;
    if (Array.isArray(track.audioRoles)) return track.audioRoles;
    return [];
  }

  /**
   * Check if a track has an audio description/accessibility role.
   */
  isAudioDescription(track) {
    const roles = this.getTrackRoles(track);
    return roles.includes("description") || roles.includes("alt") || roles.includes("supplementary");
  }

  /**
   * Check if track audio roles match preferred role characteristics.
   */
  rolesMatch(trackRoles, preferredRoles) {
    const trackHasDesc = Array.isArray(trackRoles) &&
      (trackRoles.includes("description") || trackRoles.includes("alt") || trackRoles.includes("supplementary"));
    const prefHasDesc = Array.isArray(preferredRoles) &&
      (preferredRoles.includes("description") || preferredRoles.includes("alt") || preferredRoles.includes("supplementary"));
    return trackHasDesc === prefHasDesc;
  }

  /**
   * Normalize Shaka track language.
   */
  getTrackLanguage(track) {
    if (!track) return null;

    return (
      track.language ||
      track.originalLanguage ||
      track.audioLanguage ||
      null
    );
  }

  /**
   * Get canonical preferred audio language from Shaka config or state.
   */
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

  /**
   * Get canonical preferred audio roles from active track or state.
   */
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

  /**
   * Get currently active audio language.
   */
  getCurrentAudioLanguage() {
    const tracks = this.getVariantTracks();
    const active = tracks.find(track => track.active);
    if (!active) return this._preferredLanguage || null;
    return this.getTrackLanguage(active);
  }

  /**
   * Get available audio languages.
   */
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

  /**
   * Convert Shaka track to normalized quality object.
   */
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
    return this.getVariantTracks().map(track =>
      this.normalizeTrack(track)
    );
  }

  getCurrentQuality() {
    const tracks = this.getVariantTracks();

    const active = tracks.find(track => track.active);

    const width = this.video ? this.video.videoWidth : 0;
    const height = this.video ? this.video.videoHeight : 0;

    return {
      width: active ? active.width : width,
      height: active ? active.height : height,

      bitrate: active
        ? active.bandwidth || active.bitrate || null
        : null,

      label: active
        ? `${active.height}p`
        : height > 0
          ? `${height}p`
          : "—",

      id: active ? active.id : null,

      language: active
        ? this.getTrackLanguage(active)
        : null
    };
  }

  /**
   * Resolve a requested quality string or track ID to { width, height }.
   */
  resolveResolution(qualityKey, tracks) {
    if (!tracks || !tracks.length || qualityKey == null) {
      return null;
    }

    const key = String(qualityKey).trim();

    /*
     * Direct dimension match: "1920x1080"
     */
    const dimensionMatch = key.match(/^(\d+)x(\d+)$/);
    if (dimensionMatch) {
      return {
        width: Number(dimensionMatch[1]),
        height: Number(dimensionMatch[2])
      };
    }

    /*
     * Match "1080p"
     */
    const pMatch = key.match(/^(\d+)p$/i);
    if (pMatch) {
      return this.resolveResolution(pMatch[1], tracks);
    }

    /*
     * Match height e.g. "1080"
     */
    if (/^\d+$/.test(key)) {
      const height = Number(key);
      const candidates = tracks.filter(
        track => Number(track.height) === height
      );

      if (candidates.length) {
        const targetLang = this.getPreferredLanguage(tracks);
        let preferred = candidates;

        if (targetLang) {
          const sameLanguage = candidates.filter(
            track => this.languagesMatch(this.getTrackLanguage(track), targetLang)
          );
          if (sameLanguage.length) {
            preferred = sameLanguage;
          }
        }

        return {
          width: preferred[0].width,
          height
        };
      }
    }

    /*
     * Fallback to track ID match (numeric 0, 1, 2 or string ID)
     */
    const idTrack = tracks.find(
      track => String(track.id) === key
    );

    if (idTrack) {
      return {
        width: idTrack.width,
        height: idTrack.height
      };
    }

    return null;
  }

  /**
   * Find the best track for a requested resolution while preserving
   * the preferred audio language, normal audio role, and maximizing bitrate.
   */
  findBestTrackForResolution(tracks, width, height) {
    if (!tracks || !tracks.length) {
      return null;
    }

    let matching = tracks.filter(track => {
      return (
        Number(track.width) === Number(width) &&
        Number(track.height) === Number(height)
      );
    });

    if (!matching.length) {
      return null;
    }

    const targetLang = this.getPreferredLanguage(tracks);
    const targetRoles = this.getPreferredRoles(tracks);

    let candidates = matching;

    // 1. Language matching: preserve target language if available at this resolution
    if (targetLang) {
      const sameLanguage = matching.filter(track => {
        return this.languagesMatch(this.getTrackLanguage(track), targetLang);
      });

      if (sameLanguage.length) {
        candidates = sameLanguage;
      }
      // If language is temporarily unavailable at this resolution, candidates remains matching,
      // but this._preferredLanguage is PRESERVED so it can be restored when available!
    }

    // 2. Audio role matching: ensure normal audio does NOT silently become Audio Description
    const sameRole = candidates.filter(track => {
      return this.rolesMatch(this.getTrackRoles(track), targetRoles);
    });

    if (sameRole.length) {
      candidates = sameRole;
    } else {
      // If no exact role match, strictly prioritize standard audio over description
      const nonDesc = candidates.filter(track => !this.isAudioDescription(track));
      if (nonDesc.length) {
        candidates = nonDesc;
      }
    }

    // 3. Highest bitrate among matched candidates
    candidates.sort((a, b) => {
      const bRate = b.bandwidth || b.bitrate || 0;
      const aRate = a.bandwidth || a.bitrate || 0;
      return bRate - aRate;
    });

    return candidates[0] || null;
  }

  /**
   * Set a specific resolution with language and role preservation.
   */
  setQuality(qualityKey) {
    const player = this.getPlayer();
    if (!player) return false;

    const tracks = this.getVariantTracks();
    if (!tracks.length) return false;

    const resolution = this.resolveResolution(qualityKey, tracks);
    if (!resolution) {
      console.debug("[UVC] Could not resolve quality:", qualityKey);
      return false;
    }

    const target = this.findBestTrackForResolution(
      tracks,
      resolution.width,
      resolution.height
    );

    if (!target) {
      console.debug("[UVC] No track for resolution:", resolution);
      return false;
    }

    const active = tracks.find(track => track.active);
    const targetLanguage = this.getTrackLanguage(target);
    const activeLanguage = active ? this.getTrackLanguage(active) : null;

    const isResolutionAlreadyCorrect = active &&
      Number(active.width) === Number(resolution.width) &&
      Number(active.height) === Number(resolution.height);

    const preferredLang = this.getPreferredLanguage(tracks);
    const isAudioSwitchPending = preferredLang && activeLanguage && !this.languagesMatch(preferredLang, activeLanguage);

    // If resolution is already correct:
    // 1. If an audio switch is pending, do not interrupt Shaka's audio switch!
    // 2. If active track already matches target, no-op.
    // 3. If resolution and language and role are already satisfied, avoid clearing buffer.
    if (isResolutionAlreadyCorrect) {
      if (isAudioSwitchPending) {
        console.log("[UVC] Audio switch in progress. Skipping variant re-selection to preserve user audio change.");
        return true;
      }
      if (active && String(active.id) === String(target.id)) {
        return true;
      }
      if (active && this.languagesMatch(activeLanguage, targetLanguage) &&
          this.rolesMatch(this.getTrackRoles(active), this.getTrackRoles(target))) {
        return true;
      }
    }

    try {
      player.configure({
        abr: {
          enabled: false
        }
      });

      if (!active || String(active.id) !== String(target.id)) {
        player.selectVariantTrack(target, true);

        // Only update preferred language/roles if this selection was NOT a language fallback
        if (this.languagesMatch(targetLanguage, preferredLang || targetLanguage)) {
          this._preferredLanguage = this.normalizeLanguage(targetLanguage);
          this._preferredRoles = this.getTrackRoles(target);
        }
      }

      console.log("[UVC] QUALITY LOCK");
      console.log("[UVC] Requested:", qualityKey);
      console.log("[UVC] Resolution:", `${target.width}x${target.height}`);
      console.log("[UVC] Previous language:", activeLanguage);
      console.log("[UVC] Current language:", targetLanguage);
      console.log("[UVC] Roles:", target.roles || target.audioRoles || []);
      console.log("[UVC] Track:", target.id);
      console.log("[UVC] Bitrate:", target.bandwidth || target.bitrate);
      console.log("[UVC] ABR: disabled");

      return true;
    } catch (e) {
      console.debug("[UVC] Shaka setQuality failed:", e);
      return false;
    }
  }

  /**
   * Auto mode.
   */
  setAuto() {
    const player = this.getPlayer();

    if (!player) return false;

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

  /**
   * Max Available.
   *
   * Highest resolution is selected WITHIN
   * the preferred audio language and audio role.
   */
  setMax() {
    const player = this.getPlayer();

    if (!player) return false;

    const tracks = this.getVariantTracks();

    if (!tracks.length) return false;

    const active = tracks.find(track => track.active);
    const targetLang = this.getPreferredLanguage(tracks);
    const targetRoles = this.getPreferredRoles(tracks);

    let candidates = tracks;

    // Filter by preferred language
    if (targetLang) {
      const sameLanguage = tracks.filter(track => {
        return this.languagesMatch(this.getTrackLanguage(track), targetLang);
      });

      if (sameLanguage.length) {
        candidates = sameLanguage;
      }
    }

    // Filter by audio role (normal vs Audio Description)
    const sameRole = candidates.filter(track => {
      return this.rolesMatch(this.getTrackRoles(track), targetRoles);
    });

    if (sameRole.length) {
      candidates = sameRole;
    } else {
      const nonDesc = candidates.filter(track => !this.isAudioDescription(track));
      if (nonDesc.length) {
        candidates = nonDesc;
      }
    }

    // Highest resolution first, then highest bitrate
    candidates.sort((a, b) => {
      if (b.height !== a.height) {
        return b.height - a.height;
      }

      return (
        (b.bandwidth || b.bitrate || 0) -
        (a.bandwidth || a.bitrate || 0)
      );
    });

    const target = candidates[0];

    if (!target) return false;

    const activeLang = active ? this.getTrackLanguage(active) : null;
    const isAudioSwitchPending = targetLang && activeLang && !this.languagesMatch(targetLang, activeLang);

    // If max resolution is already active and an audio switch is pending, do not interrupt
    if (active && Number(active.height) === Number(target.height) && isAudioSwitchPending) {
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

      player.selectVariantTrack(target, true);

      const targetLangResult = this.getTrackLanguage(target);
      if (this.languagesMatch(targetLangResult, targetLang || targetLangResult)) {
        this._preferredLanguage = this.normalizeLanguage(targetLangResult);
        this._preferredRoles = this.getTrackRoles(target);
      }

      console.log(
        "[UVC] Max Available locked:",
        `${target.width}x${target.height}`
      );

      console.log(
        "[UVC] Audio language preserved:",
        targetLangResult
      );

      console.log(
        "[UVC] Roles:",
        target.roles || target.audioRoles || []
      );

      console.log(
        "[UVC] Bitrate:",
        target.bandwidth || target.bitrate
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
    const player = this.getPlayer();

    if (
      player &&
      typeof player.isLive === "function"
    ) {
      try {
        return player.isLive();
      } catch (e) {}
    }

    return super.isLive();
  }

  getBitrate() {
    const current = this.getCurrentQuality();

    return current
      ? current.bitrate
      : null;
  }

  getBufferingGoal() {
    const player = this.getPlayer();

    if (
      !player ||
      typeof player.getConfiguration !== "function"
    ) {
      return null;
    }

    try {
      return (
        player.getConfiguration()
          ?.streaming
          ?.bufferingGoal ?? null
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
    const player = this.getPlayer();

    if (
      !player ||
      typeof player.configure !== "function"
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