import { VASTParser } from './vast-parser.js';
import { VASTError } from './vast-error.js';
import { EventLogger } from './event-logger.js';
import { DiagramRenderer } from './diagram-renderer.js';
import { AdPlayer } from './ad-player.js';
import { ORIENT_RATIOS, MAX_WRAPPER_DEPTH } from './constants.js';

export class VastTester {
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

    this._parser  = new VASTParser({ maxWrapperDepth: MAX_WRAPPER_DEPTH });
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

  // Auto-advance sequential playback
  _playAd(index) { this._startAd(index, { autoAdvance: true }); }

  // Preview: user manually selects an ad; no auto-advance after completion
  _previewAd(index) { this._startAd(index); }

  _startAd(index, { autoAdvance = false } = {}) {
    this._destroyPlayer();
    this._currentAdIndex = index;
    this._updateAdListItems();

    const vastData = this._ads[index];
    this._updateRawXmlPanel(vastData);

    if (vastData.adType === 'no-ad') {
      this._setStatus('No Ad', 'info');
      return;
    }

    if (autoAdvance && vastData.wrapperChain && vastData.wrapperChain.length > 1) {
      this._logger.log('wrapper-chain', `${vastData.wrapperChain.length - 1} wrapper hop(s)`, 'wrapper');
    }

    const nextIndex = autoAdvance && index + 1 < this._ads.length ? index + 1 : null;

    this._player = new AdPlayer(
      { video: this._video, audio: this._audio, banner: this._banner,
        overlay: this._overlay, skipBtn: this._skipBtn, meta: this._meta,
        placeholder: this._placeholder },
      vastData, this._logger, this._diagram, index,
      () => {
        this._adPlayedSet.add(index);
        this._updateAdListItems();
        if (nextIndex !== null) {
          this._startAd(nextIndex, { autoAdvance: true });
        }
      }
    );
    this._player.load();

    const title = vastData.adTitle || `Ad ${index + 1}`;
    document.title = `VAST Tester — ${title}`;
    const statusMsg = autoAdvance
      ? (this._ads.length > 1 ? `Ad ${index + 1}/${this._ads.length}: ${title}` : `Loaded: ${title}`)
      : `Preview — Ad ${index + 1}/${this._ads.length}: ${title}`;
    this._setStatus(statusMsg, 'success');
    this._logger.log('vast-loaded', autoAdvance ? title : `preview: ${title}`, 'vast-loaded');
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
