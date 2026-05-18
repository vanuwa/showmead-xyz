import { truncate } from './utils.js';

export class EventLogger {
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
    dt.textContent = detail ? truncate(detail, 70) : '';

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
}
