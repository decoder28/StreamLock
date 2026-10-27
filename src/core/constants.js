/**
 * Universal Video Quality & Buffer Controller
 * Constants & Message Protocol
 */

export const MSG_PAGE_SOURCE = "UVC_PAGE";
export const MSG_CONTENT_SOURCE = "UVC_CONTENT";
export const MSG_POPUP_SOURCE = "UVC_POPUP";

export const ACTION_TYPES = {
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

export const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "max", // 'auto' | 'max' | 'quality'
  selectedQualityKey: null, // e.g. "1920x1080"
  selectedTrackId: null,
  buffer: 60, // seconds
  bufferEntireVideo: false,
  liveMode: false,
  speed: 1.0,
  showPlayerOverlay: true
};

export const AGGRESSIVE_BUFFER_CONFIG = {
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

