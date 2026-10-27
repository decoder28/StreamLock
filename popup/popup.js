/**
 * Universal Video Quality & Buffer Controller - Popup Controller
 */

(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  let settings = {
    enabled: true,
    mode: "max",
    selectedTrackId: null,
    selectedQualityKey: null,
    buffer: 60,
    bufferEntireVideo: false,
    liveMode: false,
    speed: 1.0,
    showPlayerOverlay: true
  };

  let last = null;
  let lastVariantsSig = null;

  // --- 1. SAFE MESSAGE DISPATCH ---
  function req(type, p = {}) {
    return new Promise(async resolve => {
      const id = crypto.randomUUID();

      const listener = message => {
        if (message?.source !== "UVC_PAGE" || message.requestId !== id) {
          return;
        }
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message);
      };

      chrome.runtime.onMessage.addListener(listener);

      let tab = null;
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs && tabs[0];
      } catch (e) {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(null);
        return;
      }

      if (!tab?.id) {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(null);
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, {
          source: "UVC_POPUP",
          type: type,
          settings: p.settings || null,
          qualityKey: p.qualityKey ?? null,
          trackId: p.trackId ?? null,
          speed: p.speed ?? null,
          requestId: id
        });
      } catch (e) {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(null);
        return;
      }

      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(null);
      }, 1500);
    });
  }

  // Format bitrate nicely
  function mb(b) {
    if (!b || !Number.isFinite(b) || b <= 0) return "—";
    if (b >= 1000000) {
      return `${(b / 1000000).toFixed(2)} Mbps`;
    }
    return `${Math.round(b / 1000)} Kbps`;
  }

  // --- 2. RENDER POPUP STATE ---
  function render(s) {
    if (!s) return;
    last = s;

    // Header status text
    if (!s.detected) {
      $("statusText").textContent = "No active video found on page";
      $("playerType").textContent = "None";
      $("streamMode").textContent = "—";
    } else {
      $("statusText").textContent = `${s.playerType} detected`;
      $("playerType").textContent = s.playerType || "Connected";
      $("streamMode").textContent = s.isLive ? "LIVE" : "VOD";
    }

    // Resolution & Bitrate (if elements exist)
    if ($("resolution")) {
      $("resolution").textContent = (s.width && s.height) ? `${s.width} × ${s.height}` : "—";
    }
    if ($("bitrate")) {
      $("bitrate").textContent = mb(s.bandwidth);
    }

    // Buffer & ABR stats
    const bufferSupported = !!(s.capabilities && s.capabilities.bufferControl);
    const isLive = !!s.isLive;
    const isEntireActive = !!s.bufferEntireVideo && !isLive && bufferSupported;

    if (s.detected && s.buffered != null) {
      if (isEntireActive) {
        if (s.growthRate > 1.2) {
          $("buffered").textContent = `${s.buffered}s (+${s.growthRate}s/s)`;
        } else if (s.duration && s.currentTime != null && s.buffered >= (s.duration - s.currentTime - 10)) {
          $("buffered").textContent = `${s.buffered}s (Full VOD)`;
        } else {
          $("buffered").textContent = `${s.buffered}s / Entire Video`;
        }
      } else {
        $("buffered").textContent = `${s.buffered}s`;
      }
    } else {
      $("buffered").textContent = "—";
    }

    if (!s.detected || !s.capabilities?.abrControl) {
      $("abr").textContent = "—";
    } else {
      $("abr").textContent = s.abrEnabled ? "ON" : "OFF";
    }

    // Switches
    $("enabled").classList.toggle("on", !!s.enabled);
    if ($("showPlayerOverlay")) {
      const isOverlayOn = s.showPlayerOverlay !== undefined ? !!s.showPlayerOverlay : (settings.showPlayerOverlay !== false);
      settings.showPlayerOverlay = isOverlayOn;
      $("showPlayerOverlay").classList.toggle("on", isOverlayOn);
      $("showPlayerOverlay").title = isOverlayOn ? "Show Player Overlay: ON" : "Show Player Overlay: OFF";
    }
    if ($("liveMode")) $("liveMode").classList.toggle("on", !!s.liveMode);
    if ($("liveNote")) {
      if (s.isLive) {
        $("liveNote").textContent = "Live stream auto-detected";
      } else {
        $("liveNote").textContent = "Live-friendly buffering";
      }
    }

    // Buffer Capability & Control
    const bufferInput = $("buffer");
    const bufferBadge = $("bufferBadge");
    const entireBtn = $("bufferEntireVideo");

    if (bufferSupported) {
      bufferBadge.textContent = "Supported";
      bufferBadge.className = "badge success";
      bufferInput.disabled = !s.enabled;
    } else {
      bufferBadge.textContent = "Unavailable";
      bufferBadge.className = "badge muted";
      bufferInput.disabled = true;
    }

    // Buffer Entire Video Switch State
    if (entireBtn) {
      if (!s.detected || !s.enabled) {
        entireBtn.disabled = !s.enabled;
        entireBtn.title = "Buffer Entire Video";
        entireBtn.classList.toggle("on", !!settings.bufferEntireVideo);
      } else if (!bufferSupported) {
        entireBtn.disabled = true;
        entireBtn.title = "Buffer Entire Video (Unsupported for this player)";
        entireBtn.classList.remove("on");
      } else if (isLive) {
        entireBtn.disabled = true;
        entireBtn.title = "Buffer Entire Video (Unavailable for live streams)";
        entireBtn.classList.remove("on");
      } else {
        entireBtn.disabled = false;
        const isOn = (s.bufferEntireVideo !== undefined) ? !!s.bufferEntireVideo : !!settings.bufferEntireVideo;
        settings.bufferEntireVideo = isOn;
        entireBtn.classList.toggle("on", isOn);
        entireBtn.title = isOn ? "Buffer Entire Video: ON (Aggressive VOD Prebuffer)" : "Buffer Entire Video: OFF";
      }
    }

    // Only update buffer input value if user is not actively interacting with it
    if (document.activeElement !== bufferInput) {
      if (typeof s.bufferSetting === "number") {
        settings.buffer = s.bufferSetting;
      }
      bufferInput.value = String(s.bufferSetting ?? settings.buffer ?? 60);
    }

    // Speed Capability & Control
    const currentSpeed = s.speed != null ? Number(s.speed) : (settings.speed || 1.0);
    const speedBadge = $("speedBadge");
    if (speedBadge) {
      speedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
    }

    const speedBtns = document.querySelectorAll(".speed-btn");
    speedBtns.forEach(btn => {
      const btnSpeed = parseFloat(btn.dataset.speed);
      if (Math.abs(btnSpeed - currentSpeed) < 0.05) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    // Quality Capability & Control
    const qualitySelect = $("quality");
    const qualityBadge = $("qualityBadge");
    const qualitySupported = !!(s.capabilities && s.capabilities.qualitySelection);

    if (!s.detected) {
      qualityBadge.textContent = "Waiting";
      qualityBadge.className = "badge muted";
      qualitySelect.innerHTML = "<option>Waiting for player…</option>";
      qualitySelect.disabled = true;
      lastVariantsSig = null;
      updateCustomDropdown();
      return;
    }

    if (!qualitySupported || !s.variants || s.variants.length === 0) {
      qualityBadge.textContent = "Single Quality";
      qualityBadge.className = "badge muted";
      qualitySelect.innerHTML = "<option>Quality selection unavailable</option>";
      qualitySelect.disabled = true;
      lastVariantsSig = null;
      updateCustomDropdown();
      return;
    }

    qualitySelect.disabled = !s.enabled;

    if (s.mode === "auto") {
      qualityBadge.textContent = "ABR AUTO";
      qualityBadge.className = "badge success";
    } else {
      qualityBadge.textContent = "LOCKED";
      qualityBadge.className = "badge warning";
    }

    // Rebuild options ONLY when variant list changes to avoid closing or wiping user's open select
    const sig = s.variants.map(g => `${g.key}:${g.variants.length}:${g.maxBitrate}`).join("|");
    if (sig !== lastVariantsSig) {
      lastVariantsSig = sig;
      qualitySelect.innerHTML = "";

      // 1. Auto option
      const optAuto = document.createElement("option");
      optAuto.value = "auto";
      optAuto.textContent = "Auto (Adaptive Bitrate)";
      qualitySelect.appendChild(optAuto);

      // 2. Max Available option
      const optMax = document.createElement("option");
      optMax.value = "max";
      optMax.textContent = "Max Available";
      qualitySelect.appendChild(optMax);

      // 3. Grouped resolution options
      for (const group of s.variants) {
        const opt = document.createElement("option");
        opt.value = `quality:${group.key}`;
        const countStr = group.variants.length > 1 ? ` (${group.variants.length} variants)` : "";
        opt.textContent = `${group.label} • ${mb(group.maxBitrate)}${countStr}`;
        qualitySelect.appendChild(opt);
      }
    }

    // Restore dropdown selection if user is not actively interacting with the select
    if (document.activeElement !== qualitySelect) {
      if (s.mode === "auto") {
        qualitySelect.value = "auto";
      } else if (s.mode === "max") {
        qualitySelect.value = "max";
      } else if (s.mode === "track" && s.selectedTrackId != null) {
        const selected = s.allTracks?.find(t => String(t.id) === String(s.selectedTrackId));
        if (selected) {
          qualitySelect.value = `quality:${selected.width}x${selected.height}`;
        } else if (s.selectedQualityKey) {
          qualitySelect.value = `quality:${s.selectedQualityKey}`;
        }
      } else if (s.mode === "quality" && s.selectedQualityKey) {
        qualitySelect.value = `quality:${s.selectedQualityKey}`;
      }
    }

    updateCustomDropdown();

    // Diagnostics section
    $("diagAdapter").textContent = s.playerType || "None";
    $("diagQC").textContent = s.capabilities?.qualitySelection ? "Supported" : "Unavailable";
    $("diagBC").textContent = s.capabilities?.bufferControl ? "Supported" : "Unavailable";
    if ($("diagBEV")) {
      if (!s.capabilities?.bufferControl) {
        $("diagBEV").textContent = "Unsupported";
        $("diagBEV").style.whiteSpace = "normal";
        $("diagBEV").style.textAlign = "";
      } else if (isLive) {
        $("diagBEV").textContent = "Disabled (Live)";
        $("diagBEV").style.whiteSpace = "normal";
        $("diagBEV").style.textAlign = "";
      } else if (s.bufferEntireVideo) {
        const state = s.aggressiveState && s.aggressiveState !== "IDLE" ? s.aggressiveState : "FILLING";
        const targetGoal = (s.actualBufferingGoal || 376) + "s";
        const refill = (s.customRefillThreshold ?? s.bufferSetting ?? settings.buffer ?? 60) + "s";
        const curBuf = Math.round(s.buffered || s.currentBuffer || 0) + "s";

        let text = `Active (Aggressive VOD)\nState: ${state}`;
        if (state === "REFILLING" || state === "NORMAL_BUFFERING") {
          text += `\nBuffer: ${curBuf}`;
        }
        text += `\nTarget: ${targetGoal}\nRefill: ${refill}`;

        $("diagBEV").textContent = text;
        $("diagBEV").style.whiteSpace = "pre-line";
        $("diagBEV").style.textAlign = "right";
      } else {
        $("diagBEV").textContent = "Off";
        $("diagBEV").style.whiteSpace = "normal";
        $("diagBEV").style.textAlign = "";
      }
    }
    if ($("diagTimeline")) {
      if (s.duration && Number.isFinite(s.duration) && s.duration > 0) {
        const ct = Math.round(s.currentTime || 0);
        const dur = Math.round(s.duration);
        const rem = Math.max(0, dur - ct);
        $("diagTimeline").textContent = `${ct}s / ${dur}s (Rem: ${rem}s)`;
      } else {
        $("diagTimeline").textContent = isLive ? "Live (No finite end)" : "—";
      }
    }
    if ($("diagBufferStats")) {
      const bEnd = s.bufferedEnd ? Math.round(s.bufferedEnd * 10) / 10 : (s.buffered || 0);
      const bAhead = s.buffered ? Math.round(s.buffered * 10) / 10 : 0;
      $("diagBufferStats").textContent = `${bAhead}s ahead (End: ${bEnd}s)`;
    }
    if ($("diagGrowth")) {
      if (!s.detected) {
        $("diagGrowth").textContent = "—";
      } else if (s.aggressiveState === "COMPLETE" || (s.duration && s.currentTime != null && s.buffered >= (s.duration - s.currentTime - 10))) {
        $("diagGrowth").textContent = "Complete (End of VOD)";
      } else if (s.aggressiveState === "PEAK_REACHED" || s.aggressiveState === "NORMAL_BUFFERING") {
        $("diagGrowth").textContent = `Consuming Buffer (Refill at ${s.customRefillThreshold || s.bufferSetting || 120}s)`;
      } else if (s.aggressiveState === "REFILLING") {
        $("diagGrowth").textContent = "Refilling buffer toward peak…";
      } else if (s.growthRate > 0) {
        $("diagGrowth").textContent = `+${s.growthRate}s/s (${s.growthRate}x playback)`;
      } else if (s.aggressiveState === "FILLING") {
        $("diagGrowth").textContent = "Aggressive filling…";
      } else {
        $("diagGrowth").textContent = "Idle / Steady";
      }
    }
    if ($("diagGoal")) {
      const tgt = (s.bufferEntireVideo && !isLive && s.duration)
        ? Math.round(Math.max(30, (s.duration - (s.currentTime || 0)) + 30))
        : (s.bufferSetting || settings.buffer || 60);
      const act = s.actualBufferingGoal ? `${s.actualBufferingGoal}s` : `${tgt}s`;
      const prefetchStr = s.segmentPrefetchLimit != null ? ` (Prefetch: ${s.segmentPrefetchLimit})` : "";
      $("diagGoal").textContent = `${tgt}s / ${act}${prefetchStr}`;
    }
    if ($("diagBandwidth")) {
      if (s.estimatedBandwidth && s.streamBandwidth) {
        $("diagBandwidth").textContent = `${mb(s.estimatedBandwidth)} (Stream: ${mb(s.streamBandwidth)})`;
      } else if (s.estimatedBandwidth) {
        $("diagBandwidth").textContent = mb(s.estimatedBandwidth);
      } else {
        $("diagBandwidth").textContent = "—";
      }
    }
    $("diagABR").textContent = s.capabilities?.abrControl ? "Supported" : "Unavailable";
    $("diagCandidates").textContent = String(s.candidateCount || 0);
  }

  // --- 2b. CUSTOM QUALITY DROPDOWN UI SYNC ---
  function updateCustomDropdown() {
    const qualitySelect = $("quality");
    const dropdown = $("qualityDropdown");
    const trigger = $("qualityDropdownTrigger");
    const valueEl = $("qualityDropdownValue");
    const menu = $("qualityDropdownMenu");

    if (!qualitySelect || !dropdown || !trigger || !valueEl || !menu) return;

    trigger.disabled = qualitySelect.disabled;
    if (qualitySelect.disabled) {
      dropdown.classList.remove("open");
      const qualityCard = document.querySelector(".card-quality");
      if (qualityCard) qualityCard.classList.remove("dropdown-open");
      trigger.setAttribute("aria-expanded", "false");
    }

    const selectedOpt = qualitySelect.options[qualitySelect.selectedIndex] ||
      Array.from(qualitySelect.options).find(o => o.value === qualitySelect.value);

    valueEl.textContent = selectedOpt ? selectedOpt.textContent : "Max Available";

    menu.innerHTML = "";
    Array.from(qualitySelect.options).forEach((opt, idx) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "quality-option";
      item.setAttribute("role", "option");
      item.textContent = opt.textContent;
      item.dataset.value = opt.value;

      const isSelected = (opt.value === qualitySelect.value) || (idx === qualitySelect.selectedIndex);
      if (isSelected) {
        item.classList.add("selected");
        item.setAttribute("aria-selected", "true");
      } else {
        item.setAttribute("aria-selected", "false");
      }

      item.onclick = (e) => {
        e.stopPropagation();
        if (qualitySelect.disabled) return;
        qualitySelect.value = opt.value;
        qualitySelect.dispatchEvent(new Event("change", { bubbles: true }));
        dropdown.classList.remove("open");
        const qualityCard = document.querySelector(".card-quality");
        if (qualityCard) qualityCard.classList.remove("dropdown-open");
        trigger.setAttribute("aria-expanded", "false");
        updateCustomDropdown();
      };

      menu.appendChild(item);
    });
  }

  // --- 3. QUALITY SELECTION LOGIC ---
  async function selectQuality(value) {
    if (value === "auto") {
      settings.mode = "auto";
      settings.selectedTrackId = null;
      settings.selectedQualityKey = null;
      await chrome.storage.local.set(settings);
      console.log("[UVC DEBUG] AUTO REQUEST:", { mode: "auto" });
      return req("SELECT_AUTO");
    }

    if (value === "max") {
      settings.mode = "max";
      settings.selectedTrackId = null;
      settings.selectedQualityKey = null;
      await chrome.storage.local.set(settings);
      console.log("[UVC DEBUG] MAX REQUEST:", { mode: "max" });
      return req("SELECT_MAX");
    }

    if (!value.startsWith("quality:")) {
      return null;
    }

    const key = value.slice("quality:".length);

    // Find the resolution group
    const group = last?.variants?.find(item => item.key === key);
    if (!group) {
      console.warn("[UVC] Quality group not found:", key);
      return null;
    }

    /*
     * IMPORTANT:
     *
     * Do NOT blindly choose group.variants[0].
     *
     * Hotstar has:
     *
     * 1080p Hindi
     * 1080p English
     * 1080p Tamil
     * ...
     *
     * The popup must select the variant matching
     * the CURRENTLY ACTIVE audio language.
     */

    const activeTrack =
      last?.allTracks?.find(
        track => track.active
      );

    const activeLanguage =
      activeTrack?.language ||
      activeTrack?.originalLanguage ||
      null;

    let bestVariant = null;

    /*
     * First try current audio language.
     */
    if (activeLanguage) {
      const sameLanguage =
        group.variants?.filter(
          variant =>
            (
              variant.language ||
              variant.originalLanguage ||
              null
            ) === activeLanguage
        ) || [];

      if (sameLanguage.length) {
        const activeRoles = activeTrack?.roles || [];
        const isPrefDesc = activeRoles.includes("description") || activeRoles.includes("alt") || activeRoles.includes("supplementary");
        const sameRole = sameLanguage.filter(variant => {
          const vRoles = variant.roles || [];
          const vIsDesc = vRoles.includes("description") || vRoles.includes("alt") || vRoles.includes("supplementary");
          return isPrefDesc ? vIsDesc : !vIsDesc;
        });
        const pool = sameRole.length ? sameRole : sameLanguage;
        bestVariant =
          [...pool].sort(
            (a, b) =>
              (b.bitrate || b.bandwidth || 0) -
              (a.bitrate || a.bandwidth || 0)
          )[0];
      }
    }

    /*
     * Fallback only if language information isn't available.
     */
    if (!bestVariant) {
      bestVariant =
        [...(group.variants || [])].sort(
          (a, b) =>
            (b.bitrate || b.bandwidth || 0) -
            (a.bitrate || a.bandwidth || 0)
        )[0];
    }

    if (!bestVariant) {
      console.warn(
        "[UVC] No variant track found for:",
        key
      );

      return null;
    }

    /*
     * Store RESOLUTION as the real preference.
     *
     * Track ID is only diagnostic/backward compatibility.
     */
    settings.mode = "quality";
    settings.selectedTrackId = bestVariant.id;
    settings.selectedQualityKey = key;

    await chrome.storage.local.set(settings);

    console.log(
      "[UVC DEBUG] QUALITY REQUEST:",
      {
        mode: "quality",

        qualityKey: key,

        selectedTrackId:
          bestVariant.id,

        audioLanguage:
          bestVariant.language ||
          bestVariant.originalLanguage ||
          null,

        width:
          bestVariant.width,

        height:
          bestVariant.height,

        bitrate:
          bestVariant.bitrate ||
          bestVariant.bandwidth
      }
    );

    return req("SELECT_TRACK", {
      trackId: bestVariant.id,
      qualityKey: key
    });
  }

  // --- 4. APPLY SETTINGS ---
  async function saveApply() {
    const value = $("quality").value;
    const qualityResult = await selectQuality(value);

    const rawBuffer = Number($("buffer").value);
    settings.buffer = (!isNaN(rawBuffer) && rawBuffer > 0) ? rawBuffer : (settings.buffer || 60);
    settings.bufferEntireVideo = $("bufferEntireVideo") ? $("bufferEntireVideo").classList.contains("on") : !!settings.bufferEntireVideo;
    settings.liveMode = $("liveMode") ? $("liveMode").classList.contains("on") : !!settings.liveMode;
    if ($("showPlayerOverlay")) {
      settings.showPlayerOverlay = $("showPlayerOverlay").classList.contains("on");
    }

    console.log(`[UVC DEBUG] BUFFER ${settings.buffer} REQUEST:`, {
      buffer: settings.buffer,
      bufferEntireVideo: settings.bufferEntireVideo,
      liveMode: settings.liveMode
    });

    await chrome.storage.local.set(settings);

    const result = await req("SET_SETTINGS", { settings });
    if (result?.status) {
      render(result.status);
    } else if (qualityResult?.status) {
      render(qualityResult.status);
    }

    $("apply").textContent = "Applied ✓";
    setTimeout(() => {
      $("apply").textContent = "Apply Settings";
    }, 1000);
  }

  // --- 5. EVENT LISTENERS ---
  function setupEvents() {
    // Custom Quality Dropdown open/close & outside click & Escape
    const dropdown = $("qualityDropdown");
    const trigger = $("qualityDropdownTrigger");

    const qualityCard = document.querySelector(".card-quality");

    if (trigger && dropdown) {
      trigger.onclick = (e) => {
        e.stopPropagation();
        if (trigger.disabled) return;
        const willOpen = !dropdown.classList.contains("open");
        dropdown.classList.toggle("open", willOpen);
        if (qualityCard) qualityCard.classList.toggle("dropdown-open", willOpen);
        trigger.setAttribute("aria-expanded", String(willOpen));
      };

      document.addEventListener("click", (e) => {
        if (!dropdown.contains(e.target)) {
          dropdown.classList.remove("open");
          if (qualityCard) qualityCard.classList.remove("dropdown-open");
          trigger.setAttribute("aria-expanded", "false");
        }
      });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && dropdown.classList.contains("open")) {
          dropdown.classList.remove("open");
          if (qualityCard) qualityCard.classList.remove("dropdown-open");
          trigger.setAttribute("aria-expanded", "false");
        }
      });
    }

    // Quality Dropdown: immediately selects exact highest-bitrate variant
    $("quality").onchange = async () => {
      updateCustomDropdown();
      const result = await selectQuality($("quality").value);
      if (result?.status) {
        render(result.status);
      }
    };

    // Buffer Input: update stored setting immediately on change or Enter
    const handleBufferCommit = async () => {
      const rawVal = Number($("buffer").value);
      if (isNaN(rawVal) || rawVal <= 0) return;
      settings.buffer = rawVal;
      console.log(`[UVC DEBUG] BUFFER ${settings.buffer} REQUEST:`, { buffer: settings.buffer });
      await chrome.storage.local.set({ buffer: settings.buffer });
      const result = await req("SET_SETTINGS", { settings });
      if (result?.status) {
        render(result.status);
      }
    };

    $("buffer").onchange = handleBufferCommit;
    $("buffer").onkeydown = (e) => {
      if (e.key === "Enter") {
        $("buffer").blur();
      }
    };

    // Buffer Entire Video Switch
    $("bufferEntireVideo").onclick = async () => {
      if ($("bufferEntireVideo").disabled) return;
      settings.bufferEntireVideo = $("bufferEntireVideo").classList.toggle("on");
      $("bufferEntireVideo").title = settings.bufferEntireVideo ? "Buffer Entire Video: ON" : "Buffer Entire Video: OFF";
      console.log(`[UVC DEBUG] Buffer Entire Video toggled: ${settings.bufferEntireVideo}`);
      await chrome.storage.local.set({ bufferEntireVideo: settings.bufferEntireVideo });
      const result = await req("SET_SETTINGS", { settings: { bufferEntireVideo: settings.bufferEntireVideo } });
      if (result?.status) render(result.status);
    };

    // Apply Button
    $("apply").onclick = saveApply;

    // Refresh Button
    $("refresh").onclick = async () => {
      $("statusText").textContent = "Re-scanning player…";
      const result = await req("REFRESH_PLAYER");
      if (result?.status) render(result.status);
    };

    // Enabled Power Switch
    $("enabled").onclick = async () => {
      settings.enabled = $("enabled").classList.toggle("on");
      await chrome.storage.local.set({ enabled: settings.enabled });
      const result = await req("SET_SETTINGS", { settings: { enabled: settings.enabled } });
      if (result?.status) render(result.status);
    };

    // Show Player Overlay Switch
    if ($("showPlayerOverlay")) {
      $("showPlayerOverlay").onclick = async () => {
        const isCurrentlyOn = $("showPlayerOverlay").classList.contains("on");
        const nextState = !isCurrentlyOn;
        settings.showPlayerOverlay = nextState;
        $("showPlayerOverlay").classList.toggle("on", nextState);
        $("showPlayerOverlay").title = nextState ? "Show Player Overlay: ON" : "Show Player Overlay: OFF";
        console.log(`[UVC DEBUG] Show Player Overlay toggled: ${nextState}`);
        await chrome.storage.local.set({ showPlayerOverlay: nextState });
        const result = await req("SET_SETTINGS", { settings: { showPlayerOverlay: nextState } });
        if (result?.status) render(result.status);
      };
    }

    // Speed Preset Buttons
    const handleSpeedChange = async (newSpeed) => {
      const val = Number(newSpeed);
      if (!Number.isFinite(val) || val <= 0) return;
      const clamped = Math.max(0.1, Math.min(3.0, val));
      const rounded = Math.round(clamped * 10) / 10;
      settings.speed = rounded;
      await chrome.storage.local.set({ speed: settings.speed });
      console.log(`[UVC DEBUG] SPEED ${settings.speed} REQUEST`);
      const result = await req("SET_SPEED", { speed: settings.speed });
      if (result?.status) render(result.status);
    };

    document.querySelectorAll(".speed-btn").forEach(btn => {
      btn.onclick = () => {
        const val = parseFloat(btn.dataset.speed);
        if (!isNaN(val)) handleSpeedChange(val);
      };
    });

    // Diagnostics Toggle
    $("diagToggle").onclick = () => {
      const sec = $("diagSection");
      sec.classList.toggle("hidden");
      const isHidden = sec.classList.contains("hidden");
      const arrow = $("diagToggle").querySelector(".diag-arrow") || $("diagToggle").querySelector("span");
      if (arrow) arrow.textContent = isHidden ? "▾" : "▴";
      $("diagToggle").setAttribute("aria-expanded", String(!isHidden));
    };

    // Copy Diagnostics Button
    $("diagCopy").onclick = () => {
      const diagData = {
        timestamp: new Date().toISOString(),
        status: last,
        settings: settings
      };
      navigator.clipboard.writeText(JSON.stringify(diagData, null, 2)).then(() => {
        const btn = $("diagCopy");
        const orig = btn.textContent;
        btn.textContent = "Copied to Clipboard!";
        setTimeout(() => {
          btn.textContent = orig;
        }, 1500);
      });
    };

    // Incoming background messages from page
    chrome.runtime.onMessage.addListener(msg => {
      if (msg?.source === "UVC_PAGE" && msg.status) {
        render(msg.status);
      }
    });
  }

  // --- 6. INITIALIZATION ---
  async function init() {
    try {
      const stored = await chrome.storage.local.get(null);
      if (stored && typeof stored === "object") {
        settings = { ...settings, ...stored };
      }
    } catch (e) {}

    $("buffer").value = String(settings.buffer || 60);
    if ($("bufferEntireVideo")) {
      $("bufferEntireVideo").classList.toggle("on", !!settings.bufferEntireVideo);
    }
    if ($("showPlayerOverlay")) {
      const isOverlayOn = settings.showPlayerOverlay !== false;
      $("showPlayerOverlay").classList.toggle("on", isOverlayOn);
      $("showPlayerOverlay").title = isOverlayOn ? "Show Player Overlay: ON" : "Show Player Overlay: OFF";
    }
    if ($("speedBadge") && typeof settings.speed === "number") {
      $("speedBadge").textContent = `${settings.speed.toFixed(1)}x`;
    }

    setupEvents();
    updateCustomDropdown();

    const res = await req("GET_STATUS");
    if (res?.status) {
      render(res.status);
    }

    // Refresh status every 2.5 seconds without wiping dropdowns
    setInterval(async () => {
      const r = await req("GET_STATUS");
      if (r?.status) {
        render(r.status);
      }
    }, 2500);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
