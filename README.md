# Universal Video Quality & Buffer Controller — Chrome Extension (Manifest V3)

A Chrome/Chromium Manifest V3 extension built with a universal core and a player-adapter architecture to detect video players across arbitrary websites and provide unified quality locking, buffer control, and player diagnostics.

---

## 🏗️ Architecture Overview

The extension strictly isolates website specifics and player engines through a **Player Adapter** architecture:

```
Universal Core (Main World & Popup)
    │
    ├── CandidatePicker (Ranks visible/playing <video> elements over ads/previews)
    │
    ├── QualityManager (Normalized quality model, grouping duplicate resolutions, Max Available)
    │
    ├── AdapterManager (Priority-based detection & lifecycle management)
    │       │
    │       ├── JioHotstar Adapter (Domain-specific discovery hook -> Shaka Player)
    │       ├── Shaka Player Adapter (getVariantTracks, selectVariantTrack, ABR, buffer goal)
    │       ├── hls.js Adapter (levels, currentLevel lock, maxBufferLength)
    │       ├── Video.js Adapter (vjs-tech, VHS qualityLevels plugin)
    │       ├── Generic MediaSource Adapter (blob: video fallback without fake controls)
    │       └── Native HTML5 Adapter (Plain HTML5 video fallback without fake controls)
    │
    ├── Content Script Bridge (Context-invalidation-safe postMessage bridge)
    │
    └── Sleek Compact Popup UI (Dark theme, zero scrollbars, live diagnostics)
```

---

## 🚀 Key Features

1. **True Universal Core**:
   - Never assumes every website uses the same player.
   - Communicates solely through the standard `PlayerAdapter` interface.
2. **Normalized Quality Model & Grouping**:
   - Groups duplicate bitrate representations into clean resolution options (e.g. `1080p • 4.50 Mbps (3 variants)`).
   - Selecting a resolution automatically chooses the highest bitrate variant available.
3. **Quality Lock Guarantee**:
   - Prioritizes user selection over automatic quality adaptation.
   - Disables ABR and locks the track.
   - Quality is **never silently downgraded** if network drops.
4. **Buffer Control**:
   - Unified buffer target (10s, 30s, 60s, 120s).
   - Live stream friendly: automatically caps buffering in live mode (`<= 30s`) to prevent latency drift.
5. **Capability-Based UI**:
   - If a player exposes quality/buffer controls, controls are enabled with active status badges.
   - If a website/player does not expose selectable qualities (e.g. native `<video>`), it reports `Quality selection unavailable` instead of faking controls.
6. **Multi-Video Candidate Ranking**:
   - Avoids mistakenly hooking background videos, preview hover clips, or ads by scoring playing state, rendered size, audio, and duration.
7. **SPA & Dynamic Player Recreation**:
   - Uses `MutationObserver` and periodic checks to detect video element replacement or episode changes.
   - Automatically detaches and cleans up old adapters without memory leaks.
8. **Extension Context Invalidation Protection**:
   - All runtime messages are guarded with `try / catch` to eliminate console spam during extension updates.
9. **Zero-Scrollbar Popup**:
   - Dark compact layout matching the JioHotstar V2 aesthetic, crafted to fit naturally without scrollbars.
   - Includes a collapsible **Diagnostics & Capabilities** accordion with a **Copy Diagnostics** button.

---

## 🧪 Automated Test Suite

A 10-case automated test suite is included in `test/test-runner.js`:

- **Case 1**: Native HTML5 video with one quality (detects resolution, reports quality unavailable).
- **Case 2**: Shaka Player (detects 1080p/720p/480p/360p, manual selection locks quality and disables ABR, auto enables ABR).
- **Case 3**: Shaka Player duplicate 1080p variants (correctly groups variants and picks highest bitrate).
- **Case 4**: Max Available priority (picks highest resolution first, then highest bitrate within that resolution).
- **Case 5**: hls.js Adapter (detects levels, locks `currentLevel`, configures `maxBufferLength`).
- **Case 6**: Video.js Adapter with `qualityLevels` plugin (locks selected level, enables all for Auto).
- **Case 7**: Live stream detection & buffer constraint (caps buffer to `<= 30s` in live mode).
- **Case 8**: Candidate video scoring (ranks playing main video over background ads/previews).
- **Case 9**: Adapter priority resolution (`Hotstar -> Shaka -> hls.js -> Video.js -> MediaSource -> Native HTML5`).
- **Case 10**: Bitrate formatting (`Mbps`, `Kbps`, `—`).

To run tests:
```bash
node test/test-runner.js
```

---

## 📦 How to Load in Chrome

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked**.
4. Select the directory:
   `c:\Users\username\Downloads\StreamLock`
5. The extension will appear as **Universal Video Quality & Buffer Control**.
6. Open any video website (JioHotstar, HLS demo, Video.js demo, or standard HTML5 video) and click the extension icon to manage quality and buffer.
