'use strict';

// ─────────────────────────────────────────────
// VASTError
// ─────────────────────────────────────────────
class VASTError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.code = code;
    this.context = context;
    this.name = 'VASTError';
  }
}

// ─────────────────────────────────────────────
// VASTParser
// ─────────────────────────────────────────────
class VASTParser {
  constructor({ maxWrapperDepth = 5 } = {}) {
    this.maxWrapperDepth = maxWrapperDepth;
  }

  // Public entry for URL fetching. Returns { ads: vastData[], rawXml: string }.
  async fetch(url, onProgress) {
    if (onProgress) onProgress('Fetching…');

    let xml;
    let httpStatus;
    try {
      const res = await fetch(url);
      httpStatus = res.status;
      if (!res.ok) throw new VASTError(403, `HTTP ${res.status} from ${url}`);
      xml = await res.text();
      if (!xml.trim()) throw new VASTError('EMPTY', 'Empty response', { httpStatus });
    } catch (err) {
      if (err instanceof VASTError) throw err;
      throw new VASTError('CORS', err.message, { url });
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new VASTError(100, 'VAST XML parse error');

    const adEls = Array.from(doc.querySelectorAll('Ad'));

    if (adEls.length <= 1) {
      // Single-ad path: resolve full wrapper chain using pre-fetched XML.
      const result = this._emptyVastData();
      await this._fetchChain(url, result, 0, onProgress, xml);
      return { ads: [result], rawXml: xml, httpStatus };
    }

    // Multi-ad path: resolve each ad independently.
    const ads = [];
    for (let i = 0; i < adEls.length; i++) {
      const adEl = adEls[i];
      const adData = this._emptyVastData();
      adData.adId = adEl.getAttribute('id') || '';
      adData.sequence = parseInt(adEl.getAttribute('sequence') || String(i + 1), 10);
      adData.rawXmlChain.push(xml);

      const inlineEl = adEl.querySelector('InLine');
      const wrapperEl = adEl.querySelector('Wrapper');

      if (inlineEl) {
        const parsed = this._parseInline(inlineEl, doc);
        const { adId, sequence, rawXmlChain, wrapperChain } = adData;
        Object.assign(adData, parsed);
        adData.adId = adId;
        adData.sequence = sequence;
        adData.rawXmlChain = rawXmlChain;
        adData.wrapperChain = wrapperChain;
      } else if (wrapperEl) {
        const wrapperData = this._parseWrapper(wrapperEl, doc);
        adData.wrapperChain.push({ url, adTitle: wrapperData.adTitle, adSystem: wrapperData.adSystem });
        this._mergeTracking(adData, wrapperData);
        adData.impressionUrls = wrapperData.impressionUrls;
        adData.clickTrackingUrls = adData.clickTrackingUrls.concat(wrapperData.clickTrackingUrls);
        adData.errorUrl = adData.errorUrl || wrapperData.errorUrl;

        if (wrapperData.wrapperUrl) {
          if (onProgress) onProgress(`Resolving ad ${i + 1} of ${adEls.length}…`);
          await this._fetchChain(wrapperData.wrapperUrl, adData, 1, onProgress);
        }
      } else {
        adData.adType = 'no-ad';
      }

      ads.push(adData);
    }

    return { ads, rawXml: xml, httpStatus };
  }

  // Public entry for raw XML paste. Returns { ads: vastData[], rawXml: string }.
  parseXML(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    if (doc.querySelector('parsererror')) throw new VASTError(100, 'VAST XML parse error');

    const adEls = Array.from(doc.querySelectorAll('Ad'));

    if (adEls.length === 0) {
      return { ads: [{ ...this._emptyVastData(), adType: 'no-ad', rawXmlChain: [xmlString] }], rawXml: xmlString };
    }

    const ads = adEls.map((adEl, i) => {
      const inlineEl = adEl.querySelector('InLine');
      const wrapperEl = adEl.querySelector('Wrapper');
      let ad;
      if (inlineEl) ad = this._parseInline(inlineEl, doc);
      else if (wrapperEl) ad = this._parseWrapper(wrapperEl, doc);
      else ad = { ...this._emptyVastData(), adType: 'no-ad' };

      ad.adId = adEl.getAttribute('id') || '';
      ad.sequence = parseInt(adEl.getAttribute('sequence') || String(i + 1), 10);
      ad.rawXmlChain = [xmlString];
      return ad;
    });

    return { ads, rawXml: xmlString };
  }

  // Internal: resolves a single VAST URL chain into `data`. Accepts pre-fetched XML at depth 0.
  async _fetchChain(url, data, depth, onProgress, prefetchedXml = null) {
    if (depth > this.maxWrapperDepth) {
      throw new VASTError(303, `Wrapper chain exceeded ${this.maxWrapperDepth} hops`);
    }
    if (onProgress && (prefetchedXml === null || depth > 0)) {
      onProgress(`Fetching${depth > 0 ? ` wrapper hop ${depth}/${this.maxWrapperDepth}` : ''}…`);
    }

    let xml;
    if (prefetchedXml !== null) {
      xml = prefetchedXml;
    } else {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new VASTError(403, `HTTP ${res.status} from ${url}`);
        xml = await res.text();
      } catch (err) {
        if (err instanceof VASTError) throw err;
        throw new VASTError('CORS', err.message, { url });
      }
    }

    data.rawXmlChain.push(xml);
    const hop = this._parseSingleAdXML(xml);

    if (hop.adType === 'no-ad') {
      data.adType = 'no-ad';
      return;
    }

    data.wrapperChain.push({ url, adTitle: hop.adTitle, adSystem: hop.adSystem });
    this._mergeTracking(data, hop);

    if (!data.impressionUrls.length) data.impressionUrls = hop.impressionUrls;
    else data.impressionUrls = data.impressionUrls.concat(hop.impressionUrls);

    if (hop.adType === 'inline') {
      data.adType = 'inline';
      data.adTitle = hop.adTitle;
      data.adSystem = hop.adSystem;
      data.description = hop.description;
      data.mediaFiles = hop.mediaFiles;
      data.clickThrough = hop.clickThrough;
      data.clickTrackingUrls = data.clickTrackingUrls.concat(hop.clickTrackingUrls);
      data.errorUrl = data.errorUrl || hop.errorUrl;
      data.skipOffset = hop.skipOffset;
      data.duration = hop.duration;
      data.nonLinears = hop.nonLinears;
      data.companions = hop.companions;
    } else if (hop.adType === 'wrapper') {
      data.clickTrackingUrls = data.clickTrackingUrls.concat(hop.clickTrackingUrls);
      data.errorUrl = data.errorUrl || hop.errorUrl;
      if (!hop.wrapperUrl) throw new VASTError(302, 'Wrapper missing VASTAdTagURI');
      await this._fetchChain(hop.wrapperUrl, data, depth + 1, onProgress);
    }
  }

  // Internal: parses a single-ad VAST XML string, returns one vastData object.
  _parseSingleAdXML(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    if (doc.querySelector('parsererror')) throw new VASTError(100, 'VAST XML parse error');

    const adEl = doc.querySelector('Ad');
    if (!adEl) return { ...this._emptyVastData(), adType: 'no-ad' };

    const inlineEl = adEl.querySelector('InLine');
    const wrapperEl = adEl.querySelector('Wrapper');

    if (inlineEl) return this._parseInline(inlineEl, doc);
    if (wrapperEl) return this._parseWrapper(wrapperEl, doc);

    return { ...this._emptyVastData(), adType: 'no-ad' };
  }

  _parseInline(el, doc) {
    const linear = el.querySelector('Linear');
    const data = this._emptyVastData();
    data.adType = 'inline';
    data.adTitle = this._text(el, 'AdTitle');
    data.adSystem = this._text(el, 'AdSystem');
    data.description = this._text(el, 'Description');
    data.impressionUrls = this._allTexts(el, 'Impression');
    data.errorUrl = this._text(el, 'Error') || null;

    if (linear) {
      data.duration = this._text(linear, 'Duration') || null;
      data.skipOffset = linear.getAttribute('skipoffset') || null;
      data.mediaFiles = this._parseMediaFiles(linear);
      data.trackingEvents = this._parseTracking(linear);
      data.clickThrough = this._text(linear.querySelector('VideoClicks'), 'ClickThrough') || null;
      data.clickTrackingUrls = linear.querySelector('VideoClicks')
        ? this._allTexts(linear.querySelector('VideoClicks'), 'ClickTracking') : [];
    }

    data.nonLinears = this._parseNonLinears(el);
    data.companions = this._parseCompanions(el);

    return data;
  }

  _parseWrapper(el, doc) {
    const data = this._emptyVastData();
    data.adType = 'wrapper';
    data.adTitle = this._text(el, 'AdTitle');
    data.adSystem = this._text(el, 'AdSystem');
    data.wrapperUrl = this._text(el, 'VASTAdTagURI') || null;
    data.impressionUrls = this._allTexts(el, 'Impression');
    data.errorUrl = this._text(el, 'Error') || null;

    const linear = el.querySelector('Linear');
    if (linear) {
      data.trackingEvents = this._parseTracking(linear);
      const vc = linear.querySelector('VideoClicks');
      if (vc) data.clickTrackingUrls = this._allTexts(vc, 'ClickTracking');
    }

    return data;
  }

  _parseMediaFiles(linear) {
    return Array.from(linear.querySelectorAll('MediaFile')).map(mf => ({
      url: this._extractCdata(mf),
      type: mf.getAttribute('type') || '',
      delivery: mf.getAttribute('delivery') || 'progressive',
      width: parseInt(mf.getAttribute('width') || '0', 10),
      height: parseInt(mf.getAttribute('height') || '0', 10),
      bitrate: parseInt(mf.getAttribute('bitrate') || '0', 10),
    }));
  }

  _extractCdata(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
        const v = node.nodeValue.trim();
        if (v) return v;
      }
    }
    return (el.textContent || '').trim();
  }

  _parseTracking(linear) {
    const events = {};
    linear.querySelectorAll('Tracking').forEach(t => {
      const name = t.getAttribute('event');
      const url = (t.textContent || '').trim();
      if (name && url) {
        if (!events[name]) events[name] = [];
        events[name].push(url);
      }
    });
    return events;
  }

  _parseNonLinears(el) {
    return Array.from(el.querySelectorAll('NonLinear')).map(nl => ({
      width: parseInt(nl.getAttribute('width') || '0', 10),
      height: parseInt(nl.getAttribute('height') || '0', 10),
      staticResource: this._text(nl, 'StaticResource'),
      htmlResource: this._text(nl, 'HTMLResource'),
      iframeResource: this._text(nl, 'IFrameResource'),
      clickThrough: this._text(nl, 'NonLinearClickThrough'),
    }));
  }

  _parseCompanions(el) {
    return Array.from(el.querySelectorAll('Companion')).map(c => ({
      width: parseInt(c.getAttribute('width') || '0', 10),
      height: parseInt(c.getAttribute('height') || '0', 10),
      staticResource: this._text(c, 'StaticResource'),
      htmlResource: this._text(c, 'HTMLResource'),
      iframeResource: this._text(c, 'IFrameResource'),
      clickThrough: this._text(c, 'CompanionClickThrough'),
    }));
  }

  _mergeTracking(base, addition) {
    const src = addition.trackingEvents || {};
    if (!base.trackingEvents) base.trackingEvents = {};
    for (const [event, urls] of Object.entries(src)) {
      if (!base.trackingEvents[event]) base.trackingEvents[event] = [];
      base.trackingEvents[event] = base.trackingEvents[event].concat(urls);
    }
  }

  _text(parent, tagName) {
    if (!parent) return '';
    const el = parent.querySelector(tagName);
    return el ? (el.textContent || '').trim() : '';
  }

  _allTexts(parent, tagName) {
    if (!parent) return [];
    return Array.from(parent.querySelectorAll(tagName))
      .map(el => (el.textContent || '').trim())
      .filter(Boolean);
  }

  _emptyVastData() {
    return {
      adType: null,
      adTitle: '',
      adSystem: '',
      description: '',
      impressionUrls: [],
      mediaFiles: [],
      trackingEvents: {},
      clickThrough: null,
      clickTrackingUrls: [],
      errorUrl: null,
      skipOffset: null,
      duration: null,
      wrapperChain: [],
      rawXmlChain: [],
      nonLinears: [],
      companions: [],
    };
  }
}

// ─────────────────────────────────────────────
// EventLogger
// ─────────────────────────────────────────────
class EventLogger {
  constructor(listEl) {
    this._list = listEl;
  }

  log(eventName, detail = '', type = null) {
    const li = document.createElement('li');
    li.dataset.type = type || eventName;

    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = this._formatTime(new Date());

    const ev = document.createElement('span');
    ev.className = 'log-event';
    ev.textContent = eventName;

    const dt = document.createElement('span');
    dt.className = 'log-detail';
    dt.title = detail;
    dt.textContent = detail ? this._truncate(detail) : '';

    li.append(ts, ev, dt);
    this._list.append(li);
  }

  clear() {
    this._list.innerHTML = '';
  }

  _formatTime(d) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  _truncate(s, max = 70) {
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
}

// ─────────────────────────────────────────────
// DiagramRenderer
// ─────────────────────────────────────────────
class DiagramRenderer {
  constructor(containerEl) {
    this._container = containerEl;
    this._eventIds = {};
  }

  render(ads, requestUrl) {
    this._eventIds = {};
    let html = '';

    const urlDisplay = requestUrl
      ? `<span class="diag-url">${this._esc(this._trunc(requestUrl, 60))}</span>`
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

    const best = this._bestMediaFile(ad.mediaFiles);
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
    const knownEvents = ['creativeView','start','firstQuartile','midpoint','thirdQuartile','complete','pause','resume','mute','unmute','skip','close'];
    const presentEvents = knownEvents.filter(e => trackingEvents[e] && trackingEvents[e].length);

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
      html += `${i2}├─ ${this._sq('click', adIndex)} Click → <span class="diag-url">${this._esc(this._trunc(ad.clickThrough, 40))}</span>\n`;
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

  _trunc(s, max) {
    return s && s.length > max ? s.slice(0, max) + '…' : s;
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

  _bestMediaFile(files) {
    if (!files || !files.length) return null;
    const mp4prog = files.filter(f => f.delivery === 'progressive' && f.type.includes('mp4'));
    if (mp4prog.length) return mp4prog[0];
    const prog = files.filter(f => f.delivery === 'progressive');
    if (prog.length) return prog[0];
    const mp4 = files.filter(f => f.type.includes('mp4'));
    if (mp4.length) return mp4[0];
    return files[0];
  }
}

// ─────────────────────────────────────────────
// AdPlayer
// ─────────────────────────────────────────────
class AdPlayer {
  constructor(videoEl, audioEl, bannerEl, overlayEl, skipBtnEl, metaEl, placeholderEl, vastData, logger, diagram, adIndex = 0, onComplete = null) {
    this._video = videoEl;
    this._audio = audioEl;
    this._banner = bannerEl;
    this._overlay = overlayEl;
    this._skipBtn = skipBtnEl;
    this._meta = metaEl;
    this._placeholder = placeholderEl;
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
    const mf = this._selectMediaFile(vd.mediaFiles);
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

  _selectMediaFile(files) {
    if (!files || !files.length) return null;
    const mp4prog = files.filter(f => f.delivery === 'progressive' && f.type.includes('mp4'));
    if (mp4prog.length) return mp4prog[0];
    const prog = files.filter(f => f.delivery === 'progressive');
    if (prog.length) return prog[0];
    const mp4 = files.filter(f => f.type.includes('mp4'));
    if (mp4.length) return mp4[0];
    return files[0];
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

// ─────────────────────────────────────────────
// VastTester (main controller)
// ─────────────────────────────────────────────
const ORIENT_RATIOS = { landscape: 16 / 9, square: 1, portrait: 9 / 16 };

class VastTester {
  constructor() {
    this._urlInput    = document.getElementById('vast-url');
    this._loadBtn     = document.getElementById('load-btn');
    this._statusEl    = document.getElementById('input-status');
    this._rawXml      = document.getElementById('raw-xml');
    this._copyXmlBtn  = document.getElementById('copy-xml-btn');
    this._xmlDetails  = document.getElementById('xml-details');
    this._xmlHopLabel = document.getElementById('xml-hop-label');
    this._clearLogBtn = document.getElementById('clear-log-btn');
    this._video       = document.getElementById('ad-video');
    this._audio       = document.getElementById('ad-audio');
    this._banner      = document.getElementById('banner-container');
    this._overlay     = document.getElementById('player-overlay');
    this._skipBtn     = document.getElementById('skip-btn');
    this._meta        = document.getElementById('media-meta');
    this._placeholder = document.getElementById('player-placeholder');
    this._diagramPre  = document.getElementById('diagram-tree');
    this._logList     = document.getElementById('event-log');
    this._adListSection = document.getElementById('ad-list-section');
    this._adListEl    = document.getElementById('ad-list');

    this._httpStatusBadge = document.getElementById('http-status-badge');
    this._xmlToggleBtn    = document.getElementById('xml-toggle-btn');

    this._parser  = new VASTParser({ maxWrapperDepth: 5 });
    this._logger  = new EventLogger(this._logList);
    this._diagram = new DiagramRenderer(this._diagramPre);
    this._player  = null;

    // Multi-ad state
    this._ads            = [];
    this._currentAdIndex = null;
    this._adPlayedSet    = new Set();
    this._lastRequestUrl = null;
    this._lastHttpStatus = null;

    this._playerStage     = document.getElementById('player-stage');
    this._playerContainer = document.getElementById('player-container');
    this._orientBtns      = document.querySelectorAll('.orient-btn');
    this._orientation     = 'landscape';

    this._resizeObserver = new ResizeObserver(() => this._resizePlayer());
    this._resizeObserver.observe(this._playerStage);

    this._bindEvents();
    this._restoreFromUrl();
  }

  _bindEvents() {
    this._loadBtn.addEventListener('click', () => this._onLoad());
    this._urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') this._onLoad(); });
    this._clearLogBtn.addEventListener('click', () => this._logger.clear());
    this._copyXmlBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this._rawXml.textContent).catch(() => {});
    });
    this._xmlToggleBtn.addEventListener('click', () => {
      const collapsed = this._xmlDetails.classList.toggle('collapsed');
      this._xmlToggleBtn.textContent = collapsed ? '▶' : '▼';
    });
    this._orientBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.ratio !== this._orientation) this._setOrientation(btn.dataset.ratio);
      });
    });
  }

  _setOrientation(ratio) {
    this._orientation = ratio;
    this._orientBtns.forEach(b => b.classList.toggle('active', b.dataset.ratio === ratio));
    this._resizePlayer();
  }

  _resizePlayer() {
    const style = getComputedStyle(this._playerStage);
    const sw = this._playerStage.clientWidth  - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const sh = this._playerStage.clientHeight - parseFloat(style.paddingTop)  - parseFloat(style.paddingBottom);
    if (!sw || !sh) return;
    const ratio = ORIENT_RATIOS[this._orientation];
    let w, h;
    if (sw / sh > ratio) { h = sh; w = Math.round(sh * ratio); }
    else                  { w = sw; h = Math.round(sw / ratio); }
    this._playerContainer.style.width  = w + 'px';
    this._playerContainer.style.height = h + 'px';
  }

  _restoreFromUrl() {
    const tag = new URLSearchParams(location.search).get('tag');
    if (tag) {
      this._urlInput.value = tag;
      this._onLoad();
      return;
    }
    const cached = sessionStorage.getItem('vastRawXml');
    if (cached) {
      this._rawXml.textContent = cached;
    }
  }

  async _onLoad() {
    const input = this._urlInput.value.trim();
    if (!input) return;

    const isXml = input.startsWith('<');
    const isUrl = input.startsWith('http://') || input.startsWith('https://');

    if (!isXml && !isUrl) {
      this._setStatus('Enter a URL (https://…) or paste raw XML (<VAST…)', 'error');
      return;
    }

    try {
      const params = new URLSearchParams(location.search);
      params.set('tag', input);
      history.replaceState(null, '', '?' + params.toString());
    } catch (_) {}

    this._clearAdList();
    this._destroyPlayer();
    this._logger.clear();
    this._diagram.clear();
    this._rawXml.textContent = '';
    this._xmlHopLabel.textContent = '';
    this._setStatus('', 'loading');
    this._ads = [];
    this._currentAdIndex = null;
    this._adPlayedSet = new Set();
    this._lastRequestUrl = isUrl ? input : null;
    this._lastHttpStatus = null;
    if (this._httpStatusBadge) this._httpStatusBadge.hidden = true;

    try {
      let result;

      if (isXml) {
        this._setStatus('Parsing XML…', 'loading');
        result = this._parser.parseXML(input);
      } else {
        result = await this._parser.fetch(input, msg => this._setStatus(msg, 'loading'));
      }

      const { ads, rawXml } = result;
      this._ads = ads;
      this._lastHttpStatus = result.httpStatus ?? null;

      if (result.httpStatus) this._setHttpStatus(result.httpStatus);

      // Show initial XML; _updateRawXmlPanel will refine per-ad on selection
      this._rawXml.textContent = rawXml;
      sessionStorage.setItem('vastRawXml', rawXml);

      this._diagram.render(this._ads, this._lastRequestUrl);

      if (ads.length === 1 && ads[0].adType === 'no-ad') {
        this._setStatus('No Ad response', 'info');
        this._logger.log('no-ad', '', 'no-ad');
        this._renderAdList(ads);
        return;
      }

      this._renderAdList(ads);

      this._playAd(0);

    } catch (err) {
      let msg = err.message || 'Unknown error';
      if (err.code === 'CORS') {
        msg = 'Fetch failed (possibly CORS). Check the console for details.';
      } else if (err.code === 'EMPTY') {
        msg = `Empty response${err.context?.httpStatus ? ` (HTTP ${err.context.httpStatus})` : ''}`;
      } else if (err.code === 100) {
        msg = 'XML parse error — invalid VAST response';
      } else if (err.code === 303) {
        msg = 'Wrapper chain limit reached (5 hops)';
      }
      if (err.context?.httpStatus) this._setHttpStatus(err.context.httpStatus);
      this._setStatus(msg, 'error');
      this._logger.log('error', msg, 'error');
      this._diagram.updateEvent('errorUrl', 'error');
      console.error('[VASTTester]', err);
    }
  }

  // Auto-advance sequential playback: fires onComplete → plays next ad.
  _playAd(index) {
    this._destroyPlayer();
    this._currentAdIndex = index;
    this._updateAdListItems();

    const vastData = this._ads[index];
    this._updateRawXmlPanel(vastData);

    if (vastData.adType === 'no-ad') {
      this._setStatus('No Ad', 'info');
      return;
    }

    if (vastData.wrapperChain && vastData.wrapperChain.length > 1) {
      this._logger.log('wrapper-chain', `${vastData.wrapperChain.length - 1} wrapper hop(s)`, 'wrapper');
    }

    const nextIndex = index + 1 < this._ads.length ? index + 1 : null;

    this._player = new AdPlayer(
      this._video, this._audio, this._banner,
      this._overlay, this._skipBtn, this._meta, this._placeholder,
      vastData, this._logger, this._diagram, index,
      () => {
        this._adPlayedSet.add(index);
        this._updateAdListItems();
        if (nextIndex !== null) {
          this._playAd(nextIndex);
        }
      }
    );
    this._player.load();

    const title = vastData.adTitle || `Ad ${index + 1}`;
    document.title = `VAST Tester — ${title}`;
    const statusMsg = this._ads.length > 1
      ? `Ad ${index + 1}/${this._ads.length}: ${title}`
      : `Loaded: ${title}`;
    this._setStatus(statusMsg, 'success');
    this._logger.log('vast-loaded', title, 'vast-loaded');
  }

  // Preview: user manually selects an ad; no auto-advance after completion.
  _previewAd(index) {
    this._destroyPlayer();
    this._currentAdIndex = index;
    this._updateAdListItems();

    const vastData = this._ads[index];
    this._updateRawXmlPanel(vastData);

    if (vastData.adType === 'no-ad') {
      this._setStatus('No Ad', 'info');
      return;
    }

    this._player = new AdPlayer(
      this._video, this._audio, this._banner,
      this._overlay, this._skipBtn, this._meta, this._placeholder,
      vastData, this._logger, this._diagram, index,
      () => {
        this._adPlayedSet.add(index);
        this._updateAdListItems();
      }
    );
    this._player.load();

    const title = vastData.adTitle || `Ad ${index + 1}`;
    document.title = `VAST Tester — ${title}`;
    this._setStatus(`Preview — Ad ${index + 1}/${this._ads.length}: ${title}`, 'success');
    this._logger.log('vast-loaded', `preview: ${title}`, 'vast-loaded');
  }

  _updateRawXmlPanel(vastData) {
    const chains = vastData.rawXmlChain || [];
    const combined = chains.join('\n\n<!-- ═══ WRAPPER HOP ═══ -->\n\n');
    if (combined) {
      this._rawXml.textContent = combined;
      sessionStorage.setItem('vastRawXml', combined);
    }

    const hopCount = chains.length - 1;
    let label = '';
    if (this._ads.length > 1 && hopCount > 0) {
      label = `(${this._ads.length} ads, ${hopCount} hop${hopCount !== 1 ? 's' : ''})`;
    } else if (this._ads.length > 1) {
      label = `(${this._ads.length} ads)`;
    } else if (hopCount > 0) {
      label = `(${hopCount} hop${hopCount !== 1 ? 's' : ''})`;
    }
    this._xmlHopLabel.textContent = label;
  }

  _renderAdList(ads) {
    if (!this._adListSection || !ads || !ads.length) return;
    this._adListSection.hidden = false;
    this._adListEl.innerHTML = '';

    ads.forEach((ad, i) => {
      const btn = document.createElement('button');
      btn.className = 'ad-list-item';
      btn.dataset.index = String(i);

      const seq = ad.sequence || (i + 1);
      const typeStr = ad.adType || 'unknown';
      const title = ad.adTitle || ad.adId || `Ad ${seq}`;

      const seqEl = document.createElement('span');
      seqEl.className = 'ad-seq';
      seqEl.textContent = `#${seq}`;

      const badge = document.createElement('span');
      badge.className = `ad-type-badge ${typeStr}`;
      badge.textContent = typeStr.toUpperCase();

      const titleEl = document.createElement('span');
      titleEl.className = 'ad-title';
      titleEl.textContent = title;
      titleEl.title = title;

      const dot = document.createElement('span');
      dot.className = 'ad-played-dot';
      dot.title = 'Played';

      btn.append(seqEl, badge, titleEl, dot);
      btn.addEventListener('click', () => this._previewAd(i));
      this._adListEl.appendChild(btn);
    });
  }

  _updateAdListItems() {
    if (!this._adListEl) return;
    this._adListEl.querySelectorAll('.ad-list-item').forEach((item, i) => {
      item.classList.toggle('active', i === this._currentAdIndex);
      item.classList.toggle('played', this._adPlayedSet.has(i));
    });
  }

  _clearAdList() {
    if (this._adListSection) this._adListSection.hidden = true;
    if (this._adListEl) this._adListEl.innerHTML = '';
  }

  _setStatus(msg, type = 'info') {
    this._statusEl.className = type;
    if (type === 'loading') {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      this._statusEl.innerHTML = '';
      this._statusEl.append(spinner, document.createTextNode(' ' + msg));
    } else {
      this._statusEl.textContent = msg;
    }
  }

  _setHttpStatus(code) {
    if (!code || !this._httpStatusBadge) return;
    const ok = code >= 200 && code < 300;
    this._httpStatusBadge.textContent = `HTTP ${code}`;
    this._httpStatusBadge.className = ok ? 'ok' : 'error';
    this._httpStatusBadge.hidden = false;
  }

  _destroyPlayer() {
    if (this._player) {
      // Mark as played if playback was started before switching away
      if (this._player._started && this._currentAdIndex !== null) {
        this._adPlayedSet.add(this._currentAdIndex);
        this._updateAdListItems();
      }
      this._player.destroy();
      this._player = null;
    }
    document.title = 'VAST Tag Tester';
  }
}

// ─── boot ───
document.addEventListener('DOMContentLoaded', () => new VastTester());
