import { VASTError } from './vast-error.js';
import { MAX_WRAPPER_DEPTH } from './constants.js';

export class VASTParser {
  constructor({ maxWrapperDepth = MAX_WRAPPER_DEPTH } = {}) {
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
