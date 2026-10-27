/**
 * Universal Video Quality & Buffer Controller - Content Script (ISOLATED World)
 * Bridges extension storage & popup messages with page.js in MAIN World.
 */

(() => {
  "use strict";

  if (window.__UVC_CONTENT_INJECTED__) return;
  window.__UVC_CONTENT_INJECTED__ = true;

  let pageScriptResponding = false;
  window.addEventListener("message", event => {
    if (event.source === window && event.data?.source === "UVC_PAGE") {
      pageScriptResponding = true;
    }
  });

  // Fallback injection only if MAIN-world manifest injection was unsupported or failed
  function ensurePageScriptInjected() {
    if (pageScriptResponding) return;
    try {
      if (document.documentElement && !document.querySelector("script[data-uvc-script]")) {
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("page.js");
        script.setAttribute("data-uvc-script", "true");
        (document.head || document.documentElement).appendChild(script);
        script.onload = () => script.remove();
      }
    } catch (e) {
      // Ignore CSP restrictions on fallback script
    }
  }

  // Defer fallback check to avoid redundant injection when MAIN-world runs natively
  setTimeout(ensurePageScriptInjected, 1500);

  // Send stored user preferences to page.js on startup
  async function syncStoredSettings() {
    try {
      if (!chrome.storage?.local) return;
      const stored = await chrome.storage.local.get(null);
      if (stored && typeof stored === "object" && Object.keys(stored).length > 0) {
        window.postMessage(
          {
            source: "UVC_CONTENT",
            type: "SET_SETTINGS",
            settings: stored,
            requestId: "init-sync"
          },
          "*"
        );
      }
    } catch (e) {}
  }

  // Sync settings when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncStoredSettings, { once: true });
  } else {
    syncStoredSettings();
  }

  // Forward messages from page.js (MAIN world) to popup/background
  window.addEventListener("message", event => {
    if (event.source !== window || !event.data || event.data.source !== "UVC_PAGE") {
      return;
    }

    if (event.data.status && typeof event.data.status.bufferEntireVideo === "boolean") {
      try {
        if (chrome.storage?.local) {
          chrome.storage.local.set({ bufferEntireVideo: event.data.status.bufferEntireVideo });
        }
      } catch (e) {}
    }

    if (event.data.status && typeof event.data.status.showPlayerOverlay === "boolean") {
      try {
        if (chrome.storage?.local) {
          chrome.storage.local.set({ showPlayerOverlay: event.data.status.showPlayerOverlay });
        }
      } catch (e) {}
    }

    try {
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage(event.data).catch(() => {
          // Extension context invalidated or popup closed; silent catch to prevent console spam
        });
      }
    } catch (e) {
      // Context invalidated
    }
  });

  // Forward requests from popup to page.js (MAIN world)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.source !== "UVC_POPUP") return false;

    window.postMessage(
      {
        source: "UVC_CONTENT",
        type: message.type,
        settings: message.settings || null,
        qualityKey: message.qualityKey || null,
        trackId: message.trackId ?? null,
        speed: message.speed ?? null,
        requestId: message.requestId || null
      },
      "*"
    );

    sendResponse({ ok: true });
    return true;
  });
})();
