/**
 * StreamLock In-Player UI Overlay
 * 
 * Attaches a sleek, non-intrusive control badge overlay directly
 * inside the video player container using CSS containing-block mechanics.
 * 
 * Architecture (inspired by Speed Increment reference):
 * - Container: Target player ancestor (position: relative)
 * - Overlay: Absolutely pinned inside the container (position: absolute)
 * - Native CSS + activity tracking handles hover across video and player controls.
 * - Deduplication via dataset flags and cleanup on player recreation.
 */

export class PlayerOverlay {
  constructor(controller = null) {
    this.controller = controller;
    this.visible = controller?.settings?.showPlayerOverlay !== false;
    this.currentVideo = null;
    this.currentContainer = null;
    this.currentRoot = null;
    this.overlayElement = null;
    this._stylesInjected = false;
    this._hideTimer = null;
    this._boundListeners = [];
  }

  /**
   * Injects overlay CSS into document.head once.
   */
  injectStyles() {
    if (this._stylesInjected || document.getElementById("streamlock-overlay-styles")) {
      this._stylesInjected = true;
      return;
    }

    try {
      const style = document.createElement("style");
      style.id = "streamlock-overlay-styles";
      style.textContent = `
        .streamlock-player-container {
          /* Established as CSS containing block without disrupting site layout */
        }

        .streamlock-overlay {
          position: absolute !important;
          top: 14px !important;
          right: 14px !important;
          z-index: 2147483647 !important;
          display: inline-flex !important;
          align-items: center !important;
          gap: 6px !important;
          padding: 4px 8px !important;
          background: rgba(11, 15, 23, 0.85) !important;
          backdrop-filter: blur(8px) !important;
          -webkit-backdrop-filter: blur(8px) !important;
          border: 1px solid rgba(255, 255, 255, 0.14) !important;
          border-radius: 6px !important;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45) !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
          font-size: 11px !important;
          line-height: 1 !important;
          color: #f1f5f9 !important;
          user-select: none !important;
          -webkit-user-select: none !important;
          pointer-events: auto !important;
          opacity: 0 !important;
          transform: translateY(-2px) !important;
          transition: opacity 0.25s ease, transform 0.25s ease !important;
        }

        /* Show overlay when player root or container is hovered, or when overlay itself is hovered/active */
        .streamlock-player-root:hover .streamlock-overlay,
        .streamlock-player-container:hover .streamlock-overlay,
        #video-container:hover .streamlock-overlay,
        [data-testid="player-container"]:hover .streamlock-overlay,
        .shaka-video-container:hover .streamlock-overlay,
        .player-container:hover .streamlock-overlay,
        .streamlock-overlay:hover,
        .streamlock-overlay.sl-visible {
          opacity: 1 !important;
          transform: translateY(0) !important;
          pointer-events: auto !important;
        }

        /* Completely hide overlay when visibility is toggled OFF */
        .streamlock-overlay.sl-hidden,
        .streamlock-player-root:hover .streamlock-overlay.sl-hidden,
        .streamlock-player-container:hover .streamlock-overlay.sl-hidden,
        #video-container:hover .streamlock-overlay.sl-hidden,
        [data-testid="player-container"]:hover .streamlock-overlay.sl-hidden,
        .shaka-video-container:hover .streamlock-overlay.sl-hidden,
        .player-container:hover .streamlock-overlay.sl-hidden,
        .streamlock-overlay.sl-hidden:hover,
        .streamlock-overlay.sl-hidden.sl-visible {
          display: none !important;
          opacity: 0 !important;
          pointer-events: none !important;
          visibility: hidden !important;
        }

        /* Allow clicks through transparent player click-shields */
        .streamlock-player-container.streamlock-controls-active,
        .streamlock-player-root.streamlock-controls-active {
          pointer-events: auto !important;
        }

        .sl-brand {
          display: inline-flex !important;
          align-items: center !important;
          gap: 3px !important;
          font-weight: 700 !important;
          font-size: 10px !important;
          letter-spacing: 0.5px !important;
          color: #38bdf8 !important;
          padding-right: 4px !important;
          border-right: 1px solid rgba(255, 255, 255, 0.12) !important;
          cursor: pointer !important;
          user-select: none !important;
        }

        .sl-btn {
          background: rgba(30, 41, 59, 0.7) !important;
          color: #e2e8f0 !important;
          border: 1px solid rgba(255, 255, 255, 0.12) !important;
          border-radius: 4px !important;
          padding: 3px 6px !important;
          font-size: 10px !important;
          font-weight: 600 !important;
          cursor: pointer !important;
          outline: none !important;
          line-height: 1 !important;
          pointer-events: auto !important;
          transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease !important;
        }

        .sl-btn:hover {
          background: rgba(51, 65, 85, 0.9) !important;
          border-color: #38bdf8 !important;
          color: #ffffff !important;
        }

        .sl-btn.sl-active {
          background: #16a34a !important;
          border-color: #22c55e !important;
          color: #ffffff !important;
        }

        .sl-pill {
          font-size: 10px !important;
          color: #94a3b8 !important;
          padding: 2px 4px !important;
          font-variant-numeric: tabular-nums !important;
        }

        .sl-pill strong {
          color: #f1f5f9 !important;
          font-weight: 600 !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
      this._stylesInjected = true;
    } catch (e) {
      console.debug("[StreamLock] Failed to inject overlay styles:", e);
    }
  }

  /**
   * Discovers the visual player container for the given <video> element.
   * Prioritizes platform-known player containers (e.g. Hotstar, Shaka, YouTube, Video.js),
   * then walks upward inspecting rendered geometry to find the real player viewport.
   * 
   * @param {HTMLVideoElement} video 
   * @returns {HTMLElement|null}
   */
  findPlayerContainer(video) {
    if (!video || !(video instanceof HTMLVideoElement)) return null;

    // 1. Check known player container selectors (Hotstar, Shaka, HTML5, Video.js, etc.)
    const playerSelectors = [
      '[data-testid="player-container"]',
      '.shaka-video-container',
      '.player-container',
      '.video-player',
      '.html5-video-player',
      '.vjs-tech',
      '.jwplayer',
      '.bmpui-ui-watermark-provider',
      '[data-player-container]',
      '.player-wrapper'
    ];

    for (const sel of playerSelectors) {
      try {
        const match = video.closest(sel);
        if (match) {
          return match.classList.contains("vjs-tech") ? match.parentElement : match;
        }
      } catch (e) {}
    }

    // 2. Safe ancestor walk: look up to 4 levels for a well-sized container
    let current = video.parentElement;
    let bestContainer = current;
    let depth = 0;

    try {
      while (current && current !== document.body && current !== document.documentElement && depth < 4) {
        const rect = current.getBoundingClientRect();
        if (rect.width >= 120 && rect.height >= 80) {
          bestContainer = current;
          const style = window.getComputedStyle(current);
          if (
            style.position === "relative" ||
            style.position === "absolute" ||
            /player|video|media|watch/i.test(current.className || "")
          ) {
            return current;
          }
        }
        current = current.parentElement;
        depth++;
      }
    } catch (e) {}

    return bestContainer || video.parentElement || video.parentNode || null;
  }

  /**
   * Finds the overarching player root that encapsulates the video,
   * player controls (playback bar, seekbar), and click shields.
   * 
   * @param {HTMLVideoElement} video 
   * @param {HTMLElement} container 
   * @returns {HTMLElement|null}
   */
  findPlayerRoot(video, container) {
    if (!video && !container) return null;
    const base = container || video;

    const known = base.closest(
      '[data-testid="player-container"], .shaka-video-container, .player-container, .video-player, [data-player-container], .player-wrapper, #player, .watch-video'
    );
    if (known && known !== container) {
      return known;
    }

    let curr = container ? container.parentElement : (video ? video.parentElement : null);
    let depth = 0;
    while (curr && curr !== document.body && curr !== document.documentElement && depth < 4) {
      const cls = typeof curr.className === "string" ? curr.className : "";
      const id = typeof curr.id === "string" ? curr.id : "";
      if (/player|video|media|watch|stage/i.test(cls) || /player|video|watch/i.test(id)) {
        return curr;
      }
      curr = curr.parentElement;
      depth++;
    }

    return container ? (container.parentElement || container) : null;
  }

  /**
   * Attaches the overlay to the player container of the target video.
   * 
   * @param {HTMLVideoElement} video 
   * @param {object} controller 
   */
  attach(video, controller = null) {
    if (controller) this.controller = controller;
    if (this.controller?.settings && typeof this.controller.settings.showPlayerOverlay === "boolean") {
      this.visible = this.controller.settings.showPlayerOverlay;
    }
    if (!video || !(video instanceof HTMLVideoElement)) return;

    // If already attached to this video and overlay is still in DOM, just re-verify
    if (
      this.currentVideo === video &&
      this.overlayElement &&
      document.contains(this.overlayElement)
    ) {
      return;
    }

    // If video changed, detach old overlay
    if (this.currentVideo && this.currentVideo !== video) {
      this.detach();
    }

    const container = this.findPlayerContainer(video);
    if (!container) return;

    const root = this.findPlayerRoot(video, container) || container;
    this.currentRoot = root;

    this.injectStyles();

    // Establish positioning context on the player container
    try {
      const compPos = window.getComputedStyle(container).position;
      if (compPos === "static" || compPos === "unset" || !compPos) {
        container.style.position = "relative";
      }
      container.classList.add("streamlock-player-container");
      if (root && root !== container) {
        root.classList.add("streamlock-player-root");
      }
    } catch (e) {}

    // Deduplication: remove any orphaned overlay in this container
    const existing = container.querySelector(".streamlock-overlay");
    if (existing) {
      existing.remove();
    }

    // Create the overlay container
    const overlay = document.createElement("div");
    overlay.className = "streamlock-overlay";
    if (!this.visible) {
      overlay.classList.add("sl-hidden");
    }
    overlay.setAttribute("data-streamlock-overlay", "true");

    // Brand icon (Double click to turn off overlay)
    const brand = document.createElement("span");
    brand.className = "sl-brand";
    brand.textContent = "SL";
    brand.title = "StreamLock Active (Double-click to turn off)";
    brand.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    brand.ondblclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.setVisible(false);
      if (this.controller) {
        if (this.controller.settings) {
          this.controller.settings.showPlayerOverlay = false;
        }
        this.controller.applySettings();
        this.controller.sendStatus();
      }
    };
    overlay.appendChild(brand);

    // Quality button
    const qualityBtn = document.createElement("button");
    qualityBtn.className = "sl-btn sl-quality";
    qualityBtn.textContent = "—";
    qualityBtn.title = "Current Quality (Click to toggle Max/Auto)";
    qualityBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.controller) return;
      const curMode = this.controller.settings?.mode;
      if (curMode === "max") {
        this.controller.settings.mode = "auto";
        this.controller.applySettings();
      } else {
        this.controller.settings.mode = "max";
        this.controller.applySettings();
      }
      this.controller.sendStatus();
    };
    overlay.appendChild(qualityBtn);

    // Buffer stat pill
    const bufferPill = document.createElement("span");
    bufferPill.className = "sl-pill sl-buffer";
    bufferPill.innerHTML = `Buf: <strong>—</strong>`;
    bufferPill.title = "Current forward buffer ahead";
    overlay.appendChild(bufferPill);

    // Buffer Entire Video toggle button
    const bevBtn = document.createElement("button");
    bevBtn.className = "sl-btn sl-bev";
    bevBtn.textContent = "Entire: OFF";
    bevBtn.title = "Buffer Entire Video (VOD)";
    bevBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.controller) return;
      const current = !!this.controller.settings?.bufferEntireVideo;
      this.controller.settings.bufferEntireVideo = !current;
      this.controller.applySettings();
      this.controller.sendStatus();
    };
    overlay.appendChild(bevBtn);

    // Playback Speed button (cycling presets: 1.0 -> 1.5 -> 2.0 -> 3.0 -> 1.0)
    const speedBtn = document.createElement("button");
    speedBtn.className = "sl-btn sl-speed";
    speedBtn.textContent = "1.0x";
    speedBtn.title = "Playback Speed (Click to cycle)";
    speedBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.controller) return;
      const currentSpeed = this.controller.settings?.speed || 1;
      const presets = [1.0, 1.5, 2.0, 3.0];
      let nextIdx = 0;
      for (let i = 0; i < presets.length; i++) {
        if (Math.abs(presets[i] - currentSpeed) < 0.05) {
          nextIdx = (i + 1) % presets.length;
          break;
        }
      }
      this.controller.setSpeed(presets[nextIdx]);
      this.controller.sendStatus();
    };
    overlay.appendChild(speedBtn);

    // Hover & interaction listeners to guarantee visibility across video area,
    // Hotstar controls bar, and StreamLock controls.
    const show = () => {
      if (!this.visible) return;
      if (this.overlayElement) {
        this.overlayElement.classList.add("sl-visible");
      }
      if (this._hideTimer) {
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
      }
    };

    const scheduleHide = (delay = 2500) => {
      if (this._hideTimer) clearTimeout(this._hideTimer);
      if (!this.visible) return;
      this._hideTimer = setTimeout(() => {
        if (
          this.overlayElement &&
          !this.overlayElement.matches(":hover") &&
          !(this.currentRoot && this.currentRoot.matches(":hover")) &&
          !(this.currentContainer && this.currentContainer.matches(":hover"))
        ) {
          this.overlayElement.classList.remove("sl-visible");
        }
      }, delay);
    };

    const onActivity = () => {
      if (!this.visible) return;
      show();
      scheduleHide(2500);
    };

    const onLeave = (e) => {
      if (e && e.relatedTarget && this.currentRoot && this.currentRoot.contains(e.relatedTarget)) {
        return;
      }
      if (this._hideTimer) clearTimeout(this._hideTimer);
      if (this.overlayElement && !this.overlayElement.matches(":hover")) {
        this.overlayElement.classList.remove("sl-visible");
      }
    };

    const addListener = (el, type, fn) => {
      if (!el || typeof el.addEventListener !== "function") return;
      el.addEventListener(type, fn, { passive: true });
      this._boundListeners.push({ el, type, fn });
    };

    if (root) {
      addListener(root, "mouseenter", onActivity);
      addListener(root, "mousemove", onActivity);
      addListener(root, "mouseleave", onLeave);
    }

    if (container && container !== root) {
      addListener(container, "mouseenter", onActivity);
      addListener(container, "mousemove", onActivity);
      addListener(container, "mouseleave", onLeave);
    }

    addListener(overlay, "mouseenter", () => {
      show();
      try {
        container.classList.add("streamlock-controls-active");
      } catch (e) {}
    });
    addListener(overlay, "mouseleave", () => {
      scheduleHide(1500);
      try {
        container.classList.remove("streamlock-controls-active");
      } catch (e) {}
    });

    // Mount overlay to the container
    try {
      container.appendChild(overlay);
      this.currentVideo = video;
      this.currentContainer = container;
      this.overlayElement = overlay;
      video.dataset.hasStreamlockOverlay = "true";
    } catch (e) {
      console.debug("[StreamLock] Failed to append overlay to container:", e);
    }
  }

  /**
   * Updates overlay elements with fresh player status.
   * 
   * @param {object} status 
   */
  update(status) {
    if (!this.overlayElement || !document.contains(this.overlayElement) || !status) {
      return;
    }

    try {
      // 1. Quality button
      const qBtn = this.overlayElement.querySelector(".sl-quality");
      if (qBtn) {
        if (!status.capabilities?.qualitySelection) {
          qBtn.textContent = status.height ? `${status.height}p` : "Auto";
        } else if (status.mode === "auto") {
          qBtn.textContent = status.height ? `Auto (${status.height}p)` : "Auto";
        } else if (status.mode === "max") {
          qBtn.textContent = status.height ? `Max (${status.height}p)` : "Max";
        } else if (status.height) {
          qBtn.textContent = `${status.height}p`;
        } else {
          qBtn.textContent = "Auto";
        }
      }

      // 2. Buffer stat pill
      const bPill = this.overlayElement.querySelector(".sl-buffer");
      if (bPill) {
        const bAhead = Math.round(status.buffered || status.currentBuffer || 0);
        bPill.innerHTML = `Buf: <strong>${bAhead}s</strong>`;
      }

      // 3. Buffer Entire Video button
      const bevBtn = this.overlayElement.querySelector(".sl-bev");
      if (bevBtn) {
        if (status.isLive) {
          bevBtn.textContent = "Live";
          bevBtn.disabled = true;
          bevBtn.classList.remove("sl-active");
        } else if (status.bufferEntireVideo) {
          bevBtn.disabled = false;
          bevBtn.classList.add("sl-active");
          const state = status.aggressiveState && status.aggressiveState !== "IDLE"
            ? status.aggressiveState
            : "ON";
          bevBtn.textContent = `Entire: ${state}`;
          const targetGoal = status.actualBufferingGoal || 376;
          const refillGoal = status.customRefillThreshold || status.bufferSetting || 60;
          bevBtn.title = `Buffer Entire Video: ${state} (Target: ${targetGoal}s, Refill: ${refillGoal}s)`;
        } else {
          bevBtn.disabled = false;
          bevBtn.classList.remove("sl-active");
          bevBtn.textContent = "Entire: OFF";
          bevBtn.title = "Buffer Entire Video: OFF";
        }
      }

      // 4. Speed button
      const spdBtn = this.overlayElement.querySelector(".sl-speed");
      if (spdBtn) {
        const currentSpeed = status.speed || 1;
        spdBtn.textContent = currentSpeed.toFixed(1) + "x";
        spdBtn.title = `Playback Speed: ${currentSpeed.toFixed(1)}x (Click to cycle)`;
      }
    } catch (e) {}
  }

  /**
   * Toggles visibility of the in-player overlay without detaching or destroying it.
   * 
   * @param {boolean} visible 
   */
  setVisible(visible) {
    this.visible = visible !== false;
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
    if (this.overlayElement) {
      if (this.visible) {
        this.overlayElement.classList.remove("sl-hidden");
        if (this.controller) {
          this.update(this.controller.getStatus());
        }
      } else {
        this.overlayElement.classList.remove("sl-visible");
        this.overlayElement.classList.add("sl-hidden");
      }
    }
    if (!this.visible) {
      if (this.currentContainer) {
        try {
          this.currentContainer.classList.remove("streamlock-controls-active");
        } catch (e) {}
      }
      if (this.currentRoot) {
        try {
          this.currentRoot.classList.remove("streamlock-controls-active");
        } catch (e) {}
      }
    }
  }

  /**
   * Cleans up overlay from the DOM and clears references.
   */
  detach() {
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }

    if (this._boundListeners) {
      for (const item of this._boundListeners) {
        try {
          item.el.removeEventListener(item.type, item.fn);
        } catch (e) {}
      }
      this._boundListeners = [];
    }

    if (this.overlayElement) {
      try {
        if (this.overlayElement.parentNode) {
          this.overlayElement.parentNode.removeChild(this.overlayElement);
        }
      } catch (e) {}
      this.overlayElement = null;
    }

    if (this.currentContainer) {
      try {
        this.currentContainer.classList.remove("streamlock-controls-active");
        this.currentContainer.classList.remove("streamlock-player-container");
      } catch (e) {}
      this.currentContainer = null;
    }

    if (this.currentRoot) {
      try {
        this.currentRoot.classList.remove("streamlock-player-root");
        this.currentRoot.classList.remove("streamlock-controls-active");
      } catch (e) {}
      this.currentRoot = null;
    }

    if (this.currentVideo) {
      try {
        delete this.currentVideo.dataset.hasStreamlockOverlay;
      } catch (e) {}
      this.currentVideo = null;
    }
  }
}
