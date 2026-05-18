import { selectMediaFile, truncate } from './utils.js';
import { VAST_TRACKING_EVENTS } from './constants.js';

export class DiagramRenderer {
  constructor(containerEl) {
    this._container = containerEl;
    this._eventIds = {};
  }

  render(ads, requestUrl) {
    this._eventIds = {};
    let html = '';

    const urlDisplay = requestUrl
      ? `<span class="diag-url">${this._esc(truncate(requestUrl, 60))}</span>`
      : '';
    html += `VAST Request ${urlDisplay}\n`;

    if (ads.length === 1) {
      const ad = ads[0];
      if (ad.adType === 'no-ad') {
        html += `└─ <span class="diag-warn">No Ad</span>\n`;
        this._container.innerHTML = html;
        return;
      }
      html += this._renderAdBranch(ad, '', 0);
    } else {
      for (let adIdx = 0; adIdx < ads.length; adIdx++) {
        const ad = ads[adIdx];
        const isLastAd = adIdx === ads.length - 1;
        const adConnector = isLastAd ? '└─' : '├─';
        const adChildPrefix = isLastAd ? '   ' : '│  ';
        const adLabel = ad.adTitle ? ` ${this._esc(ad.adTitle)}` : '';
        html += `${adConnector} Ad #${adIdx + 1}:${adLabel}\n`;
        html += this._renderAdBranch(ad, adChildPrefix, adIdx);
      }
    }

    this._container.innerHTML = html;
  }

  _renderAdBranch(ad, prefix, adIndex) {
    let html = '';
    const chain = ad.wrapperChain || [];

    if (ad.adType === 'no-ad') {
      html += `${prefix}└─ <span class="diag-warn">No Ad</span>\n`;
      return html;
    }

    for (let i = 0; i < chain.length - 1; i++) {
      const hop = chain[i];
      const hopPrefix = prefix + '   '.repeat(i);
      html += `${hopPrefix}└─ <span class="diag-info">Wrapper</span>`;
      if (hop.adTitle) html += `: ${this._esc(hop.adTitle)}`;
      html += ` <span class="diag-url">(hop ${i + 1}/${chain.length - 1})</span>\n`;
    }

    const depth = Math.max(0, chain.length - 1);
    const indent = prefix + '   '.repeat(depth);

    html += `${indent}└─ <span class="diag-info">InLine</span>`;
    if (ad.adTitle) html += `: ${this._esc(ad.adTitle)}`;
    html += '\n';

    const i2 = indent + '   ';

    if (ad.duration) {
      html += `${i2}├─ Duration: <span class="diag-info">${this._esc(this._fmtDuration(ad.duration))}</span>\n`;
    }

    const best = selectMediaFile(ad.mediaFiles);
    if (best) {
      html += `${i2}├─ MediaFile: <span class="diag-info">${this._esc(best.type || 'unknown')}</span>`;
      if (best.width && best.height) html += ` ${best.width}×${best.height}`;
      if (best.bitrate) html += ` ${best.bitrate}kbps`;
      html += '\n';
    }

    if (ad.impressionUrls && ad.impressionUrls.length) {
      html += `${i2}├─ ${this._sq('impression', adIndex)} Impression (${ad.impressionUrls.length} URL${ad.impressionUrls.length > 1 ? 's' : ''})\n`;
    }

    const trackingEvents = ad.trackingEvents || {};
    const presentEvents = VAST_TRACKING_EVENTS.filter(e => trackingEvents[e] && trackingEvents[e].length);

    if (presentEvents.length) {
      html += `${i2}├─ Tracking Events\n`;
      const ei = i2 + '│  ';
      for (let idx = 0; idx < presentEvents.length; idx++) {
        const ev = presentEvents[idx];
        const isLast = idx === presentEvents.length - 1;
        html += `${ei}${isLast ? '└─' : '├─'} ${this._sq(ev, adIndex)} ${ev}\n`;
      }
    }

    if (ad.clickThrough) {
      html += `${i2}├─ ${this._sq('click', adIndex)} Click → <span class="diag-url">${this._esc(truncate(ad.clickThrough, 40))}</span>\n`;
    }

    if (ad.errorUrl) {
      html += `${i2}└─ ${this._sq('errorUrl', adIndex)} Error URL\n`;
    } else {
      html += `${i2}└─ (no error URL)\n`;
    }

    return html;
  }

  updateEvent(eventName, state, adIndex = 0) {
    const id = `diag-sq-${adIndex}-${eventName}`;
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `diag-square diag-node--${state}`;
    el.textContent = state === 'fired' ? '■' : state === 'error' ? '■' : '■';
  }

  clear() {
    this._container.innerHTML = '';
  }

  _sq(eventName, adIndex = 0) {
    const id = `diag-sq-${adIndex}-${eventName}`;
    return `<span class="diag-square diag-node--pending" id="${id}">■</span>`;
  }

  _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _fmtDuration(d) {
    if (!d) return '';
    const parts = d.split(':');
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const s = parseInt(parts[2], 10);
      if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      return `${m}:${String(s).padStart(2,'0')}`;
    }
    return d;
  }
}
