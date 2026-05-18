import { selectMediaFile } from './utils.js';

export class AdPlayer {
  constructor({ video, audio, banner, overlay, skipBtn, meta, placeholder }, vastData, logger, diagram, adIndex = 0, onComplete = null) {
    this._video = video;
    this._audio = audio;
    this._banner = banner;
    this._overlay = overlay;
    this._skipBtn = skipBtn;
    this._meta = meta;
    this._placeholder = placeholder;
    this._vastData = vastData;
    this._logger = logger;
    this._diagram = diagram;
    this._adIndex = adIndex;
    this._onComplete = onComplete;

    this._started = false;
    this._wasMuted = false;
    this._quartileFired = { firstQuartile: false, midpoint: false, thirdQuartile: false };
    this._completeFired = false;
    this._durationSeconds = null;
    this._skipOffsetSeconds = null;
    this._listeners = [];
    this._mediaEl = null;
  }

  load() {
    const vd = this._vastData;

    // NonLinear / banner
    if ((!vd.mediaFiles || !vd.mediaFiles.length) && vd.nonLinears && vd.nonLinears.length) {
      this._loadBanner(vd.nonLinears[0]);
      return;
    }

    // Audio-only detection
    const mf = selectMediaFile(vd.mediaFiles);
    if (!mf) {
      this._placeholder.textContent = 'No playable media file found';
      return;
    }

    if (!mf.url || !/^https?:\/\//i.test(mf.url)) {
      this._placeholder.textContent = `Media URL invalid or empty: "${mf.url}"`;
      return;
    }

    const isAudio = mf.type && mf.type.startsWith('audio/');
    this._mediaEl = isAudio ? this._audio : this._video;

    if (isAudio) {
      this._audio.style.display = 'block';
      this._placeholder.style.display = 'none';
    } else {
      this._video.style.display = 'block';
      this._placeholder.style.display = 'none';
      this._overlay.style.bottom = '44px';
      this._overlay.style.pointerEvents = 'auto';
    }

    this._mediaEl.src = mf.url;
    this._meta.textContent = `${mf.type || 'unknown'}  ${mf.width ? mf.width + '×' + mf.height : ''}  ${mf.bitrate ? mf.bitrate + 'kbps' : ''}`.trim();

    if (vd.duration) {
      this._durationSeconds = this._parseDuration(vd.duration);
    }

    if (vd.skipOffset) {
      this._skipOffsetSeconds = this._parseOffset(vd.skipOffset, this._durationSeconds);
    }

    this._attachListeners();
    this._logger.log('media-ready', mf.url);
    this._mediaEl.play().catch(() => {});
  }

  _loadBanner(nl) {
    this._placeholder.style.display = 'none';
    this._banner.style.display = 'block';

    if (nl.htmlResource) {
      this._banner.innerHTML = nl.htmlResource;
    } else if (nl.staticResource) {
      const img = document.createElement('img');
      img.src = nl.staticResource;
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
      if (nl.clickThrough) {
        img.style.cursor = 'pointer';
        img.onclick = () => window.open(nl.clickThrough, '_blank');
      }
      this._banner.appendChild(img);
    } else if (nl.iframeResource) {
      const iframe = document.createElement('iframe');
      iframe.src = nl.iframeResource;
      iframe.style.width = nl.width ? nl.width + 'px' : '100%';
      iframe.style.height = nl.height ? nl.height + 'px' : '100%';
      iframe.style.border = 'none';
      this._banner.appendChild(iframe);
    }

    this._logger.log('banner-displayed', '', 'vast-loaded');
    this._fireImpression();
  }

  _attachListeners() {
    const el = this._mediaEl;
    const on = (ev, fn) => { el.addEventListener(ev, fn); this._listeners.push([ev, fn]); };

    on('play', () => {
      if (!this._started) {
        this._started = true;
        this._wasMuted = el.muted;
        this._fireImpression();
        this._fireTracking('start', 'start');
        this._fireTracking('creativeView', 'creativeView');
      } else {
        this._fireTracking('resume', 'resume');
      }
    });

    on('pause', () => {
      if (this._started && !el.ended) {
        this._fireTracking('pause', 'pause');
      }
    });

    on('ended', () => {
      if (!this._completeFired) {
        this._completeFired = true;
        this._fireTracking('complete', 'complete');
        if (this._onComplete) this._onComplete();
      }
    });

    on('volumechange', () => {
      const nowMuted = el.muted || el.volume === 0;
      if (nowMuted && !this._wasMuted) {
        this._wasMuted = true;
        this._fireTracking('mute', 'mute');
      } else if (!nowMuted && this._wasMuted) {
        this._wasMuted = false;
        this._fireTracking('unmute', 'unmute');
      }
    });

    on('timeupdate', () => {
      if (!this._started) return;

      const duration = this._durationSeconds || el.duration;
      if (!duration || duration === Infinity || isNaN(duration)) return;

      const pct = el.currentTime / duration;

      if (!this._quartileFired.firstQuartile && pct >= 0.25) {
        this._quartileFired.firstQuartile = true;
        this._fireTracking('firstQuartile', 'firstQuartile');
      }
      if (!this._quartileFired.midpoint && pct >= 0.50) {
        this._quartileFired.midpoint = true;
        this._fireTracking('midpoint', 'midpoint');
      }
      if (!this._quartileFired.thirdQuartile && pct >= 0.75) {
        this._quartileFired.thirdQuartile = true;
        this._fireTracking('thirdQuartile', 'thirdQuartile');
      }

      if (this._skipOffsetSeconds !== null && this._skipBtn.hidden) {
        if (el.currentTime >= this._skipOffsetSeconds) {
          this._skipBtn.hidden = false;
        }
      }
    });

    on('error', () => {
      const code = el.error ? el.error.code : 0;
      this._logger.log('media-error', `MediaError code ${code}`, 'error');
      this._diagram.updateEvent('errorUrl', 'error', this._adIndex);
      this._fireErrorUrl(405);
    });

    const overlayClick = () => {
      this._firePixels(this._vastData.clickTrackingUrls, 'click');
      this._logger.log('click', this._vastData.clickThrough || '', 'click');
      this._diagram.updateEvent('click', 'fired', this._adIndex);
      if (this._vastData.clickThrough) window.open(this._vastData.clickThrough, '_blank');
    };
    this._overlay.addEventListener('click', overlayClick);
    this._listeners.push(['__overlay', overlayClick]);

    const skipClick = () => {
      this._skipBtn.hidden = true;
      this._fireTracking('skip', 'skip');
      el.pause();
    };
    this._skipBtn.addEventListener('click', skipClick);
    this._listeners.push(['__skip', skipClick]);

    if (this._skipOffsetSeconds !== null) {
      this._skipBtn.hidden = true;
    }
  }

  _fireImpression() {
    this._firePixels(this._vastData.impressionUrls, 'impression');
    this._logger.log('impression', this._vastData.impressionUrls.length ? this._vastData.impressionUrls[0] : '', 'impression');
    this._diagram.updateEvent('impression', 'fired', this._adIndex);
  }

  _fireTracking(eventName, logType) {
    const urls = (this._vastData.trackingEvents || {})[eventName] || [];
    this._firePixels(urls, eventName);
    this._logger.log(eventName, urls.length ? urls[0] : '', logType || eventName);
    this._diagram.updateEvent(eventName, 'fired', this._adIndex);
  }

  _firePixels(urls, eventName) {
    (urls || []).forEach(url => {
      if (!url) return;
      const img = new Image();
      img.src = url;
    });
  }

  _fireErrorUrl(code) {
    if (!this._vastData.errorUrl) return;
    const url = this._vastData.errorUrl.replace('[ERRORCODE]', code);
    const img = new Image();
    img.src = url;
    this._logger.log('error-fired', url, 'error');
    this._diagram.updateEvent('errorUrl', 'error', this._adIndex);
  }

  _parseDuration(str) {
    if (!str) return null;
    const parts = str.split(':');
    if (parts.length !== 3) return null;
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  }

  _parseOffset(offset, durationSec) {
    if (!offset) return null;
    if (offset.endsWith('%')) {
      const pct = parseFloat(offset) / 100;
      return durationSec ? durationSec * pct : null;
    }
    return this._parseDuration(offset);
  }

  destroy() {
    if (this._mediaEl) {
      this._listeners.forEach(([ev, fn]) => {
        if (ev === '__overlay') this._overlay.removeEventListener('click', fn);
        else if (ev === '__skip') this._skipBtn.removeEventListener('click', fn);
        else this._mediaEl.removeEventListener(ev, fn);
      });
      this._mediaEl.pause();
      this._mediaEl.src = '';
      this._mediaEl.style.display = 'none';
    }
    this._audio.style.display = 'none';
    this._video.style.display = 'none';
    this._banner.style.display = 'none';
    this._banner.innerHTML = '';
    this._overlay.style.pointerEvents = 'none';
    this._overlay.style.bottom = '0';
    this._skipBtn.hidden = true;
    this._meta.textContent = '';
    this._placeholder.style.display = '';
    this._placeholder.textContent = 'Load a VAST tag to begin';
    this._listeners = [];
    this._mediaEl = null;
  }
}
