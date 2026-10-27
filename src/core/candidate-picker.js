/**
 * Candidate Video Picker
 * Ranks all <video> elements on the page (including inside Shadow DOM trees)
 * to accurately select the main content player rather than background previews or ads.
 */

export class CandidatePicker {
  static findAllVideos(root = document) {
    let videos = [];
    try {
      videos = Array.from(root.querySelectorAll("video"));
      const allElements = root.querySelectorAll("*");
      for (let i = 0; i < allElements.length; i++) {
        if (allElements[i].shadowRoot) {
          videos = videos.concat(CandidatePicker.findAllVideos(allElements[i].shadowRoot));
        }
      }
    } catch (e) {}
    return videos;
  }

  static pickBestVideo() {
    const videos = CandidatePicker.findAllVideos();
    if (!videos.length) {
      return { video: null, score: 0, candidates: [] };
    }

    if (videos.length === 1) {
      const v = videos[0];
      return {
        video: v,
        score: CandidatePicker.scoreVideo(v),
        candidates: [{ video: v, score: CandidatePicker.scoreVideo(v) }]
      };
    }

    const scored = videos.map(video => ({
      video,
      score: CandidatePicker.scoreVideo(video),
      details: CandidatePicker.getVideoDetails(video)
    }));

    scored.sort((a, b) => b.score - a.score);

    return {
      video: scored[0]?.video || null,
      score: scored[0]?.score || 0,
      candidates: scored
    };
  }

  static scoreVideo(video) {
    if (!video || !(video instanceof HTMLVideoElement)) return -1000;

    let score = 0;

    try {
      const rect = video.getBoundingClientRect();
      const style = window.getComputedStyle(video);

      const isVisible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        parseFloat(style.opacity || "1") > 0.05 &&
        rect.width > 30 &&
        rect.height > 30;

      if (!isVisible) {
        score -= 500;
      } else {
        score += 100;
      }

      const renderedArea = (rect.width * rect.height);
      score += Math.min(renderedArea / 5000, 300);

      if (video.videoWidth > 0 && video.videoHeight > 0) {
        score += 150;
        const intrinsicArea = (video.videoWidth * video.videoHeight);
        score += Math.min(intrinsicArea / 10000, 200);
      }

      const isPlaying = !video.paused && !video.ended && video.readyState > 2;
      if (isPlaying) {
        score += 400;
      }

      if (Number.isFinite(video.duration) && video.duration > 30) {
        score += 100;
      } else if (video.duration === Infinity) {
        score += 200;
      }

      if (!video.muted && video.volume > 0) {
        score += 80;
      }

      if (video.currentTime > 1) {
        score += 50;
      }

      if (video.buffered && video.buffered.length > 0) {
        score += 50;
      }
    } catch (e) {
      score = 0;
    }

    return Math.round(score);
  }

  static getVideoDetails(video) {
    try {
      const rect = video.getBoundingClientRect();
      return {
        id: video.id || null,
        className: video.className || null,
        src: video.currentSrc || video.src || null,
        width: video.videoWidth,
        height: video.videoHeight,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        paused: video.paused,
        currentTime: Math.round(video.currentTime),
        duration: Number.isFinite(video.duration) ? Math.round(video.duration) : "Live"
      };
    } catch (e) {
      return {};
    }
  }
}
