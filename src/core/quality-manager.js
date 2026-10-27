/**
 * Quality Manager
 *
 * Groups video qualities while preserving
 * separate audio-language variants.
 */

export class QualityManager {

  static groupQualities(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) {
      return [];
    }

    const map = new Map();

    for (const track of tracks) {
      if (!track || !track.height) continue;

      const width =
        track.width ||
        Math.round(track.height * (16 / 9));

      const language =
        track.language ||
        track.originalLanguage ||
        null;

      /*
       * IMPORTANT:
       *
       * Resolution alone is NOT the group key.
       *
       * 1080p Hindi and 1080p English
       * must remain separate internally.
       */
      const key =
        `${width}x${track.height}`;

      if (!map.has(key)) {
        map.set(key, []);
      }

      const bitrate =
        track.bitrate ||
        track.bandwidth ||
        0;

      map.get(key).push({
        ...track,

        width,
        bitrate,
        bandwidth: bitrate,

        language
      });
    }

    const groups = [];

    for (const [key, variants] of map.entries()) {

      variants.sort(
        (a, b) =>
          (b.bitrate || 0) -
          (a.bitrate || 0)
      );

      const best = variants[0];

      groups.push({
        key,

        width: best.width,
        height: best.height,

        label: `${best.height}p`,

        maxBitrate:
          best.bitrate || 0,

        variants,

        active:
          variants.some(v => v.active)
      });
    }

    groups.sort((a, b) => {

      if (b.height !== a.height) {
        return b.height - a.height;
      }

      return (
        b.maxBitrate -
        a.maxBitrate
      );
    });

    return groups;
  }

  static getMaxAvailable(groups) {
    if (!groups || !groups.length) {
      return null;
    }

    const topGroup = groups[0];

    return (
      topGroup.variants?.[0] ||
      null
    );
  }

  static formatBitrate(bitsPerSec) {

    if (
      !bitsPerSec ||
      !Number.isFinite(bitsPerSec) ||
      bitsPerSec <= 0
    ) {
      return "—";
    }

    if (bitsPerSec >= 1000000) {
      return (
        `${(
          bitsPerSec / 1000000
        ).toFixed(2)} Mbps`
      );
    }

    return (
      `${Math.round(
        bitsPerSec / 1000
      )} Kbps`
    );
  }
}