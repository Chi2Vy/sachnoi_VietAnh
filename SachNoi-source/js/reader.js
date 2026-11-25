// Trình đọc: lật trang (StPageFlip), zoom/pan, thumbnails, mục lục, tìm kiếm, voice, tự lật, toàn màn hình.
import * as DB from './db.js';
import { LANGUAGES, Voice } from './voice.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const AUTO_INTERVAL = 9000;

export class Reader {
  constructor({ toast, onClose }) {
    this.toast = toast;
    this.onClose = onClose;
    this.el = $('#reader');
    this.stage = $('#stage');
    this.zoomWrap = $('#zoomWrap');
    this.bookEl = $('#book');
    this.pan = $('#panLayer');
    this.voice = new Voice();
    this.flip = null;
    this.book = null;
    this.zoom = 1;
    this.tx = 0;
    this.ty = 0;
    this.mode = localStorage.getItem('gs.mode') || 'double';
    this.sound = localStorage.getItem('gs.sound') !== '0';
    this.autoTimer = null;
    this.reading = false;
    this.readToken = 0;
    this.followVoice = false;
    this.panel = null;
    this.audioCtx = null;
    this.urls = [];
    this.thumbUrls = [];
    this.pageImages = [];
    this._bind();
  }

  /* ---------------- mở / đóng ---------------- */
  async open(id, startPage = 0) {
    const book = await DB.getBook(id);
    if (!book) return false;
    if (this.isOpen) this.close();
    this.book = book;
    this.pages = await DB.getPages(id);
    this.texts = await DB.getTexts(id);
    this.n = this.pages.length;
    if (!this.n) return false;
    this.urls = this.pages.map((p) => URL.createObjectURL(p.img));
    this.el.classList.toggle('bilingual-reader', !!book.bilingualReader);
    this.el.hidden = false;
    document.body.style.overflow = 'hidden';
    $('#rTitle').textContent = book.title;
    $('#rAuthor').textContent = book.author || '';
    document.title = `${book.title} — Sách Nói`;
    const slider = $('#rSlider');
    slider.max = this.n;
    $('#sliderMax').textContent = this.n;
    $('#rPageTotal').textContent = this.n;
    $('#dlBtn').hidden = book.kind !== 'pdf';
    this.zoom = 1;
    this.tx = this.ty = 0;
    this._applyZoom();
    this._syncButtons();
    this._buildToc();
    this._buildThumbs();
    this._resetSearch();
    this.closePanel();
    startPage = clamp(startPage, 0, this.n - 1);
    this.cur = startPage;
    this._build(startPage);
    this._vNote();
    DB.patchBook(id, { updatedAt: Date.now() });
    return true;
  }

  close() {
    this.stopVoice();
    this._stopAuto();
    this.closePanel();
    this.thumbObserver?.disconnect();
    if (document.fullscreenElement) document.exitFullscreen?.();
    try { this.flip?.destroy(); } catch {}
    this.flip = null;
    this.bookEl.innerHTML = '';
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    this.thumbUrls = [];
    this.pageImages = [];
    this.el.hidden = true;
    this.book = null;
    document.body.style.overflow = '';
    document.title = 'Sách Nói — thư viện đọc sách lật trang';
  }

  get isOpen() {
    return !!this.book && !this.el.hidden;
  }

  /* ---------------- dựng sách ---------------- */
  _single() {
    return this._requiresSinglePage() || this.mode === 'single';
  }

  _requiresSinglePage() {
    return this.n === 1 || !!this.book?.bilingualReader;
  }

  _build(startIdx) {
    if (this.flip) {
      try { this.flip.destroy(); } catch {}
      this.flip = null;
    }
    // StPageFlip.destroy() gỡ luôn phần tử gốc khỏi DOM -> tạo lại khi cần
    if (!this.bookEl.isConnected) {
      this.bookEl = Object.assign(document.createElement('div'), { id: 'book' });
      this.zoomWrap.append(this.bookEl);
    }
    this.bookEl.innerHTML = '';
    const single = this._single();
    this._builtSingle = single;
    this.pageImages = this.urls.map((url, index) => {
      const image = new Image();
      image.alt = `Trang ${index + 1}`;
      image.draggable = false;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = url;
      return image;
    });
    if (this.book.bilingualReader) {
      this._showSinglePage(startIdx);
      return;
    }
    const ratio = this.book.pw / this.book.ph;
    const base = 600;
    this.flip = new St.PageFlip(this.bookEl, {
      width: Math.round(base * ratio),
      height: base,
      size: 'stretch',
      minWidth: single ? 6000 : 100,
      maxWidth: single ? 9000 : 4000,
      minHeight: 100,
      maxHeight: 6000,
      showCover: !single,
      usePortrait: single,
      drawShadow: true,
      maxShadowOpacity: 0.45,
      flippingTime: 650,
      mobileScrollSupport: false,
      swipeDistance: 24,
      startPage: startIdx,
      startZIndex: 5,
      autoSize: false,
      useMouseEvents: true,
    });
    this._preloadPages(startIdx);
    const leaves = this.pageImages.map((image) => {
      const leaf = document.createElement('div');
      leaf.className = 'book-leaf';
      leaf.append(image);
      return leaf;
    });
    this.flip.loadFromHTML(leaves);
    if (!single) this.flip.getPage(0).setDensity('soft');
    this.flip.on('flip', (e) => this._onFlip(e.data));
    this.cur = this.flip.getCurrentPageIndex();
    this.focusedPage = startIdx;
    this._updateUI();
    this._syncButtons();
  }

  _showSinglePage(index, addHistory = false) {
    this.cur = this.focusedPage = index;
    const pageImage = this.pageImages[index];
    pageImage.className = 'single-book-page';
    this.bookEl.replaceChildren(pageImage);
    this._updateUI(addHistory);
  }

  _onFlip(idx) {
    if (!this.isOpen) return;
    const changed = this.cur !== idx;
    this.cur = idx;
    if (!this._visible().includes(this.focusedPage)) this.focusedPage = idx;
    this._updateUI();
    if (changed) this._playFlipSound();
    DB.patchBook(this.book.id, { lastPage: this.focusedPage });
    if (changed && this.reading && !this.followVoice) this.startVoice();
  }

  _visible() {
    const collection = this.flip?.getPageCollection();
    return collection?.getSpread()[collection.getSpreadIndexByPage(this.cur)] ?? [this.cur];
  }

  _updateUI(addHistory = false) {
    const vis = this._visible();
    this._preloadPages(vis[0]);
    const label = vis.length === 2 ? `${vis[0] + 1}–${vis[1] + 1}` : `${vis[0] + 1}`;
    $('#rLabel').textContent = `${label} / ${this.n}`;
    $('#rSpreadRange').textContent = label;
    const jump = $('#rPage');
    jump.value = this.focusedPage + 1;
    jump.removeAttribute('aria-invalid');
    $('#rSlider').value = this.focusedPage + 1;
    $('#edgePrev').disabled = vis[0] === 0;
    const atLastPage = this.focusedPage === this.n - 1;
    $('#edgeNext').disabled = atLastPage;
    const bilingual = !!this.book.bilingualReader;
    $$('.page-nav [data-act="first"], .page-nav [data-act="prev"]').forEach((button) => {
      button.disabled = bilingual && this.focusedPage === 0;
    });
    $$('.page-nav [data-act="last"], .page-nav [data-act="next"]').forEach((button) => {
      button.disabled = bilingual && atLastPage;
    });
    if (atLastPage && this.autoTimer) this._stopAuto();
    $('#vPageNo').textContent = this.focusedPage + 1;
    this._refreshAudioState();
    this._syncPageVoiceButtons();
    if (this.panel === 'text') this._showPageText();
    $$('.thumb', $('#thumbs')).forEach((t) => t.classList.toggle('cur', vis.includes(+t.dataset.i)));
    const hash = `#/read/${this.book.id}/${this.focusedPage + 1}`;
    if (location.hash !== hash) {
      if (addHistory) history.pushState(null, '', hash);
      else history.replaceState(null, '', hash);
    }
  }

  _preloadPages(index) {
    const start = Math.max(0, index - 2);
    const end = Math.min(this.pageImages.length, index + 4);
    for (let i = start; i < end; i++) this.pageImages[i].loading = 'eager';
  }

  /* ---------------- điều hướng ---------------- */
  goTo(idx, { followVoice = false, fromHistory = false } = {}) {
    idx = clamp(idx, 0, this.n - 1);
    if (this.book?.bilingualReader) {
      if (idx === this.focusedPage) {
        this._updateUI();
        return;
      }
      if (this.reading && !followVoice) this.stopVoice();
      this._showSinglePage(idx, !followVoice && !fromHistory);
      DB.patchBook(this.book.id, { lastPage: idx });
      return;
    }
    if (!this.flip) return;
    const previous = this.focusedPage;
    this.focusedPage = idx;
    if (this._visible().includes(idx)) {
      this._updateUI();
      DB.patchBook(this.book.id, { lastPage: idx });
      if (this.reading && !followVoice && previous !== idx) this.startVoice();
      return;
    }
    this.followVoice = followVoice;
    try {
      this.flip.turnToPage(idx);
    } finally {
      this.followVoice = false;
    }
  }
  next() {
    if (this.book?.bilingualReader) return this.goTo(this.focusedPage + 1);
    if (this.flip?.getState() === 'flipping') return;
    if (this.focusedPage < this.n - 1 && this._visible().at(-1) === this.n - 1) {
      this.goTo(this.n - 1);
      return;
    }
    this.flip?.flipNext();
  }
  prev() {
    if (this.book?.bilingualReader) return this.goTo(this.focusedPage - 1);
    if (this.flip?.getState() === 'flipping') return;
    this.flip?.flipPrev();
  }

  /* ---------------- zoom & pan ---------------- */
  setZoom(z, cx, cy) {
    const old = this.zoom;
    z = clamp(Math.round(z * 100) / 100, 1, 4);
    if (z === old) return;
    if (cx != null) {
      const r = this.stage.getBoundingClientRect();
      const px = cx - r.left - r.width / 2;
      const py = cy - r.top - r.height / 2;
      this.tx = px - ((px - this.tx) * z) / old;
      this.ty = py - ((py - this.ty) * z) / old;
    }
    this.zoom = z;
    if (z === 1) this.tx = this.ty = 0;
    this._applyZoom();
  }
  _applyZoom() {
    const r = this.stage.getBoundingClientRect();
    const mx = ((this.zoom - 1) * r.width) / 2;
    const my = ((this.zoom - 1) * r.height) / 2;
    this.tx = clamp(this.tx, -mx, mx);
    this.ty = clamp(this.ty, -my, my);
    this.zoomWrap.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
    this.pan.hidden = this.zoom <= 1;
    $('#zoomVal').textContent = `${Math.round(this.zoom * 100)}%`;
  }

  /* ---------------- bảng bên ---------------- */
  openPanel(name) {
    this.panel = name;
    const titles = { pages: 'Danh sách trang', toc: 'Mục lục', search: 'Tìm trong sách', text: 'Chọn văn bản', voice: 'Nghe đọc', help: 'Hướng dẫn đọc sách' };
    $('#drawerTitle').textContent = titles[name];
    $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
    this._syncPanelButtons();
    const d = $('#drawer');
    d.inert = false;
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    if (name === 'text') this._showPageText();
    (name === 'search' ? $('#searchInput') : $('#drawerClose')).focus({ preventScroll: true });
    if (name === 'pages') {
      const cur = $('.thumb.cur', $('#thumbs'));
      cur?.scrollIntoView({ block: 'nearest' });
    }
  }
  closePanel() {
    const trigger = this.panel === 'help' ? $('#rHelp') : $('.dk[data-panel="' + this.panel + '"]');
    this.panel = null;
    const d = $('#drawer');
    if (d.contains(document.activeElement)) trigger?.focus({ preventScroll: true });
    d.inert = true;
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    this._syncPanelButtons();
  }
  togglePanel(name) {
    this.panel === name ? this.closePanel() : this.openPanel(name);
  }

  _syncPanelButtons() {
    $$('.dock button[data-panel]').forEach((button) => {
      const expanded = button.dataset.panel === this.panel;
      button.setAttribute('aria-expanded', String(expanded));
      button.classList.toggle('on', expanded || (button.dataset.panel === 'voice' && this.reading));
    });
    $('#rHelp').setAttribute('aria-expanded', String(this.panel === 'help'));
  }

  _showPageText() {
    const visible = this._visible();
    const picker = $('#rTextPage');
    const selection = Number(picker.value);
    const current = visible.includes(selection) ? selection : visible[0];
    picker.replaceChildren(...visible.map((page) => new Option(`Trang ${page + 1}`, page)));
    picker.value = current;
    this._selectPageText();
  }

  _selectPageText() {
    const text = (this.texts[Number($('#rTextPage').value)] || '').trim();
    $('#rTextContent').value = text;
    $('#rTextField').hidden = !text;
    $('#rTextEmpty').hidden = !!text;
    $('#rCopyText').hidden = !text;
  }

  async _copyPageText() {
    const field = $('#rTextContent');
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selection = field.value.slice(start, end) || field.value;
    if (!selection) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(selection);
    } catch {
      field.focus();
      field.setSelectionRange(start === end ? 0 : start, start === end ? field.value.length : end);
      if (!document.execCommand('copy')) {
        this.toast('Văn bản đã được chọn. Nhấn Ctrl+C hoặc dùng menu Sao chép.');
        return;
      }
    }
    this.toast('Đã sao chép văn bản.');
  }

  _buildThumbs() {
    const box = $('#thumbs');
    box.innerHTML = '';
    this.thumbObserver?.disconnect();
    const ar = `${this.book.pw} / ${this.book.ph}`;
    const io = this.thumbObserver = new IntersectionObserver(
      (ents) => {
        for (const e of ents) {
          if (!e.isIntersecting) continue;
          const b = e.target;
          io.unobserve(b);
          const i = +b.dataset.i;
          const u = URL.createObjectURL(this.pages[i].thumb);
          this.thumbUrls.push(u);
          b.querySelector('.ph').replaceWith(Object.assign(new Image(), { src: u, alt: `Trang ${i + 1}`, loading: 'lazy' }));
        }
      },
      { root: $('.drawer-body'), rootMargin: '200px' }
    );
    this.pages.forEach((_, i) => {
      const b = document.createElement('button');
      b.className = 'thumb';
      b.dataset.i = i;
      b.style.setProperty('--ar', ar);
      b.innerHTML = `<div class="ph"></div><span>${i + 1}</span>`;
      b.onclick = () => {
        this.goTo(i);
        if (innerWidth < 720) this.closePanel();
      };
      box.append(b);
      io.observe(b);
    });
  }

  _buildToc() {
    const ol = $('#toc');
    ol.innerHTML = '';
    const items = (this.book.outline || []).filter((o) => o.page != null);
    if (!items.length) {
      ol.innerHTML = `<li class="hint">Sách này không có mục lục (bookmark) trong file gốc. Dùng tab “Danh sách trang” hoặc thanh trượt để chuyển trang.</li>`;
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      li.innerHTML = `<button style="padding-left:${10 + it.level * 16}px"><span>${esc(it.title)}</span><span>${it.page + 1}</span></button>`;
      li.firstChild.onclick = () => {
        this.goTo(it.page);
        if (innerWidth < 720) this.closePanel();
      };
      ol.append(li);
    }
  }

  /* ---------------- tìm kiếm ---------------- */
  _resetSearch() {
    $('#searchInput').value = '';
    $('#searchResults').innerHTML = '';
    $('#searchInfo').textContent = this.book.hasText ? '' : 'Sách này không có lớp chữ (PDF scan hoặc ảnh) nên không tìm kiếm được.';
  }
  search(q) {
    const out = $('#searchResults');
    out.innerHTML = '';
    q = q.trim();
    if (q.length < 2) {
      $('#searchInfo').textContent = 'Nhập ít nhất 2 ký tự.';
      return;
    }
    const nq = norm(q);
    const hits = [];
    this.texts.forEach((t, i) => {
      const nt = norm(t);
      const pos = nt.indexOf(nq);
      if (pos < 0) return;
      let count = 0,
        p = -1;
      while ((p = nt.indexOf(nq, p + 1)) >= 0) count++;
      const s = Math.max(0, pos - 40);
      const snip = t.slice(s, pos + q.length + 80).replace(/\s+/g, ' ');
      const rel = pos - s;
      const html = `${s > 0 ? '…' : ''}${esc(snip.slice(0, rel))}<mark>${esc(snip.slice(rel, rel + q.length))}</mark>${esc(snip.slice(rel + q.length))}…`;
      hits.push({ i, count, html });
    });
    $('#searchInfo').textContent = hits.length ? `Tìm thấy ở ${hits.length} trang.` : 'Không tìm thấy kết quả.';
    for (const h of hits.slice(0, 200)) {
      const li = document.createElement('li');
      li.innerHTML = `<button><b>Trang ${h.i + 1}${h.count > 1 ? ` · ${h.count} lần` : ''}</b>${h.html}</button>`;
      li.firstChild.onclick = () => {
        this.goTo(h.i);
        if (innerWidth < 720) this.closePanel();
      };
      out.append(li);
    }
  }

  /* ---------------- voice ---------------- */
  _vNote() {
    const v = this.voice;
    const note = $('#vNote');
    const sel = $('#vVoice');
    const fill = () => {
      const list = v.languageVoices;
      const cur = v.pickVoice();
      const label = LANGUAGES[v.language].label;
      $('#vLang').value = v.language;
      sel.replaceChildren(...list.map((voice) => new Option(`${voice.name} (${voice.lang})`, voice.voiceURI, false, voice === cur)));
      sel.disabled = !list.length;
      if (!list.length) sel.append(new Option('Chưa có giọng trong danh sách', ''));
      note.textContent = !v.supported
        ? 'Trình duyệt này không hỗ trợ đọc văn bản. Hãy dùng Chrome, Edge hoặc Safari.'
        : !list.length
          ? `Chưa tìm thấy giọng ${label}. Bạn có thể thêm giọng trong cài đặt thiết bị.`
          : '';
    };
    v.onVoices = fill;
    fill();
    $('#vRate').value = v.rate;
    $('#vRateVal').textContent = `${v.rate.toFixed(1)}×`;
  }

  async startVoice(pageIndex = this.focusedPage, language = null) {
    this.activePageLanguage = language;
    const my = ++this.readToken;
    this.voice.stop(true);
    this.reading = true;
    this._voiceUI(true);
    let p = pageIndex;
    let startedOnce = false;
    while (this.reading && my === this.readToken && p < this.n) {
      const page = this.pages[p];
      const text = this.texts[p] || '';
      if (!page.audio && text.trim().length < 2) {
        if (!$('#vCont').checked) {
          this.toast('Trang này không có chữ hoặc âm thanh để đọc.');
          break;
        }
        p++;
        continue;
      }
      if (p !== this.focusedPage) this.goTo(p, { followVoice: true });
      this.voicePage = p;
      this._syncPageVoiceButtons();
      $('#readingChipText').textContent = `Đang đọc trang ${p + 1}`;
      startedOnce = true;
      this._showTranscript(null);
      const ok = await this.voice.speakPage({ text, audioBlob: language ? page.voiceTracks?.[language] : page.audio }).catch((e) => {
        this.toast(e.message);
        return false;
      });
      if (my !== this.readToken) return;
      if (!ok) break; // lỗi hoặc bị dừng
      if (language || !$('#vCont').checked) break;
      p++;
    }
    if (my === this.readToken) {
      if (!startedOnce && this.reading && $('#vCont').checked) this.toast('Không còn trang nào có thể đọc.');
      this.reading = false;
      this._voiceUI(false);
    }
  }

  stopVoice() {
    this.readToken++;
    this.reading = false;
    this.voice.stop();
    this._voiceUI(false);
  }

  toggleVoice() {
    if (this.reading) {
      if (this.voice.state === 'paused') this.voice.resume();
      else this.voice.pause();
      this._voiceUI(true);
    } else this.startVoice();
  }

  _voiceUI(active) {
    const paused = this.voice.state === 'paused';
    const btn = $('#vPlay');
    btn.querySelector('use').setAttribute('href', active && !paused ? '#i-pause' : '#i-play');
    btn.querySelector('span').textContent = !active ? 'Đọc từ trang này' : paused ? 'Tiếp tục' : 'Tạm dừng';
    $('#vStop').disabled = !active;
    $('#readingChip').hidden = !active;
    $('.voice-btn').classList.toggle('on', active || this.panel === 'voice');
    this._updateAudioPosition();
    this._syncPageVoiceButtons();
  }

  _syncPageVoiceButtons() {
    const pages = this.isOpen ? this._visible() : [];
    $$('.page-voice').forEach((button, i) => {
      const bilingual = this.book?.bilingualReader;
      const index = bilingual ? pages[0] : pages[i];
      const page = this.pages?.[index];
      const language = bilingual ? (page?.voiceTracks?.both ? ['both'][i] : ['vi', 'en'][i]) : '';
      const languageLabel = { vi: 'Tiếng Việt', en: 'Tiếng Anh', both: 'Bản thu chung' }[language];
      button.dataset.language = language || '';
      button.querySelector('span').textContent = languageLabel || '';
      if (bilingual) {
        button.hidden = !page?.voiceTracks?.[language];
        button.disabled = button.hidden;
        button.dataset.page = index;
        const playing = this.reading && this.voicePage === index
          && this.activePageLanguage === language && this.voice.state !== 'paused';
        button.title = button.hidden ? '' : `${playing ? 'Tạm dừng' : 'Phát'} ${languageLabel}`;
        button.setAttribute('aria-label', button.title);
        button.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
        return;
      }
      button.hidden = !page;
      button.disabled = !page || (!page.audio && (this.texts[index] || '').trim().length < 2);
      if (!page) return;
      button.dataset.page = index;
      const playing = this.reading && this.voicePage === index && this.voice.state !== 'paused';
      const label = playing ? `Tạm dừng trang ${index + 1}` : `Phát trang ${index + 1}`;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    });
  }

  _showTranscript(c) {
    const box = $('#vTranscript');
    if (!c) {
      box.textContent = '';
      return;
    }
    if (c.kind === 'audio') {
      box.textContent = c.text;
      return;
    }
    box.innerHTML = c.all.map((s, i) => (i === c.index ? `<span class="now">${esc(s)}</span>` : esc(s))).join(' ');
    box.querySelector('.now')?.scrollIntoView({ block: 'nearest' });
  }

  _refreshAudioState() {
    const p = this.pages?.[this.focusedPage];
    if (!p) return;
    $('#vAudioDel').hidden = !p.audio;
    $('#vAudioState').textContent = p.audio ? 'Đã có file âm thanh' : '';
  }

  _updateAudioPosition() {
    const audio = this.voice.audio;
    const active = this.reading && audio.hasAttribute('src');
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const seek = $('#rAudioSeek');
    $('#rAudioPlayback').hidden = !active;
    seek.max = duration;
    seek.value = active ? audio.currentTime : 0;
    seek.disabled = !active || duration <= 0;
    const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    $('#rAudioTime').textContent = `${time(active ? audio.currentTime : 0)} / ${time(duration)}`;
  }

  async attachAudio(file) {
    const i = this.focusedPage;
    const rec = this.pages[i];
    rec.audio = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mpeg' });
    await DB.putPage(rec);
    this._refreshAudioState();
    this._syncPageVoiceButtons();
    this.toast(`Đã gắn âm thanh cho trang ${i + 1}`);
  }
  async removeAudio() {
    const i = this.focusedPage;
    const rec = this.pages[i];
    rec.audio = null;
    await DB.putPage(rec);
    this._refreshAudioState();
    this._syncPageVoiceButtons();
  }

  /* ---------------- tự lật / âm thanh / toàn màn hình ---------------- */
  _toggleAuto() {
    if (this.autoTimer) return this._stopAuto();
    if (this.focusedPage === this.n - 1) {
      this.toast('Bạn đang ở trang cuối.');
      return;
    }
    $('#autoBtn').classList.add('on');
    this.autoTimer = setInterval(() => {
      this.next();
    }, AUTO_INTERVAL);
    this.toast(`Tự động lật trang mỗi ${AUTO_INTERVAL / 1000} giây`);
  }
  _stopAuto() {
    clearInterval(this.autoTimer);
    this.autoTimer = null;
    $('#autoBtn').classList.remove('on');
  }

  _playFlipSound() {
    if (!this.sound) return;
    try {
      const ctx = (this.audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      // Hai nhịp sột soạt: nhấc mép giấy rồi thả trang xuống.
      const duration = 0.21;
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
      const samples = buffer.getChannelData(0);
      let smoothed = 0;
      for (let i = 0; i < samples.length; i++) {
        const time = i / ctx.sampleRate;
        const lift = Math.sin(Math.PI * Math.min(time / 0.15, 1)) ** 2;
        const settle = time < 0.12 ? 0 : Math.sin(Math.PI * Math.min((time - 0.12) / 0.09, 1)) ** 2;
        const noise = Math.random() * 2 - 1;
        smoothed += 0.32 * (noise - smoothed);
        samples[i] = (noise * 0.25 + smoothed * 0.75) * (0.12 * lift + 0.055 * settle);
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 3800;
      source.connect(filter).connect(ctx.destination);
      source.start();
    } catch {}
  }

  _toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.el.requestFullscreen?.().catch(() => this.toast('Trình duyệt không cho bật toàn màn hình.'));
  }

  async _download() {
    const f = await DB.getFile(this.book.id);
    if (!f) return this.toast('Không có file gốc để tải.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f.blob);
    a.download = f.name || `${this.book.title}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  _syncButtons() {
    $('#soundBtn').classList.toggle('on', this.sound);
    const single = this._single();
    $('#modeBtn').disabled = this._requiresSinglePage();
    $('#modeBtn use').setAttribute('href', single ? '#i-single' : '#i-double');
    $('#modeBtn').classList.toggle('on', single);
    $('#fullBtn use').setAttribute('href', document.fullscreenElement ? '#i-unfull' : '#i-full');
  }

  /* ---------------- gắn sự kiện (1 lần) ---------------- */
  _bind() {
    $$('.page-voice').forEach((button) => {
      button.onclick = () => {
        const page = Number(button.dataset.page);
        const language = button.dataset.language || null;
        if (this.reading && this.voicePage === page && this.activePageLanguage === language) this.toggleVoice();
        else this.startVoice(page, language);
      };
    });
    $('#rBack').onclick = () => this.onClose();
    $('#rHelp').onclick = () => this.togglePanel('help');
    $('#drawerClose').onclick = () => this.closePanel();
    $('#edgePrev').onclick = () => this.prev();
    $('#edgeNext').onclick = () => this.next();

    $('#rSlider').addEventListener('input', (e) => {
      $('#rLabel').textContent = `${e.target.value} / ${this.n}`;
    });
    $('#rSlider').addEventListener('change', (e) => this.goTo(+e.target.value - 1));
    $('#rJump').onsubmit = (event) => {
      event.preventDefault();
      const input = $('#rPage');
      const value = input.value.trim();
      const page = Number(value);
      if (!/^\d+$/.test(value) || page < 1 || page > this.n) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        input.select();
        this.toast(`Nhập số trang từ 1 đến ${this.n}.`);
        return;
      }
      this.goTo(page - 1);
    };
    $('#rPage').oninput = (event) => event.target.removeAttribute('aria-invalid');
    $('#rPage').onfocus = (event) => event.target.select();
    $('#rTextPage').onchange = () => this._selectPageText();
    $('#rCopyText').onclick = () => this._copyPageText();

    $$('.dock [data-panel]').forEach((b) => (b.onclick = () => this.togglePanel(b.dataset.panel)));
    $$('.dock [data-act], .page-nav [data-act]').forEach(
      (b) =>
        (b.onclick = () => {
          const a = b.dataset.act;
          if (a === 'first') this.goTo(0);
          else if (a === 'last') this.goTo(this.n - 1);
          else if (a === 'prev') this.prev();
          else if (a === 'next') this.next();
          else if (a === 'zin') this.setZoom(this.zoom + 0.5);
          else if (a === 'zout') this.setZoom(this.zoom - 0.5);
          else if (a === 'zreset') this.setZoom(1);
          else if (a === 'mode') {
            this.mode = this.mode === 'single' ? 'double' : 'single';
            localStorage.setItem('gs.mode', this.mode);
            this._syncButtons();
            this._build(this.focusedPage);
          } else if (a === 'auto') this._toggleAuto();
          else if (a === 'sound') {
            this.sound = !this.sound;
            localStorage.setItem('gs.sound', this.sound ? '1' : '0');
            this._syncButtons();
            if (this.sound) this._playFlipSound();
          } else if (a === 'download') this._download();
          else if (a === 'full') this._toggleFull();
        })
    );

    $('#searchForm').onsubmit = (e) => {
      e.preventDefault();
      this.search($('#searchInput').value);
    };

    $('#vPlay').onclick = () => this.toggleVoice();
    $('#vStop').onclick = () => this.stopVoice();
    $('#vLang').replaceChildren(...Object.entries(LANGUAGES).map(([code, { label }]) => new Option(label, code)));
    $('#vLang').onchange = (e) => {
      this.voice.setLanguage(e.target.value);
      if (this.reading && !this.voice.audio.hasAttribute('src')) this.startVoice();
    };
    $('#vVoice').onchange = (e) => {
      this.voice.setVoice(e.target.value);
      if (this.reading && !this.voice.audio.hasAttribute('src')) this.startVoice();
    };
    $('#vRate').oninput = (e) => {
      this.voice.setRate(+e.target.value);
      $('#vRateVal').textContent = `${(+e.target.value).toFixed(1)}×`;
    };
    $('#vRate').onchange = () => {
      if (this.reading && !this.voice.audio.hasAttribute('src')) this.startVoice();
    };
    this.voice.onState = () => this.isOpen && this._voiceUI(this.reading);
    this.voice.onChunk = (c) => this._showTranscript(c);
    $('#vAudioFile').onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.attachAudio(f);
    };
    $('#vAudioDel').onclick = () => this.removeAudio();
    for (const name of ['loadedmetadata', 'durationchange', 'timeupdate', 'emptied']) {
      this.voice.audio.addEventListener(name, () => this._updateAudioPosition());
    }
    $('#rAudioSeek').oninput = (event) => {
      const audio = this.voice.audio;
      if (!event.target.disabled) audio.currentTime = Number(event.target.value);
    };

    document.addEventListener('fullscreenchange', () => this._syncButtons());

    // zoom/pan bằng chuột & cảm ứng
    let drag = null;
    this.pan.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
      this.pan.setPointerCapture(e.pointerId);
      this.pan.classList.add('drag');
    });
    this.pan.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.tx = drag.tx + dx;
      this.ty = drag.ty + dy;
      this._applyZoom();
    });
    const end = () => {
      drag = null;
      this.pan.classList.remove('drag');
    };
    this.pan.addEventListener('pointerup', end);
    this.pan.addEventListener('pointercancel', end);
    this.pan.addEventListener('dblclick', (e) => this.setZoom(1, e.clientX, e.clientY));
    this.stage.addEventListener('dblclick', (e) => {
      if (this.zoom === 1 && !e.target.closest('.edge')) this.setZoom(2.5, e.clientX, e.clientY);
    });

    let wheelLock = 0;
    this.stage.addEventListener(
      'wheel',
      (e) => {
        if (!this.isOpen) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) return this.setZoom(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
        if (this.zoom > 1) {
          this.tx -= e.deltaX;
          this.ty -= e.deltaY;
          return this._applyZoom();
        }
        const now = Date.now();
        if (now - wheelLock < 600 || Math.abs(e.deltaY) < 8) return;
        wheelLock = now;
        e.deltaY > 0 ? this.next() : this.prev();
      },
      { passive: false }
    );

    // pinch zoom (2 ngón)
    const pts = new Map();
    let pinch0 = null;
    let pageSwipe = null;
    this.stage.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, e);
      if (this.book?.bilingualReader && this.zoom === 1 && pts.size === 1 && e.button === 0 && !e.target.closest('button')) {
        pageSwipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
      if (pts.size === 2) {
        pageSwipe = null;
        const [a, b] = [...pts.values()];
        pinch0 = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: this.zoom };
      }
    });
    this.stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, e);
      if (pts.size === 2 && pinch0) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        this.setZoom(pinch0.z * (d / pinch0.d), (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      }
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch0 = null;
      if (pageSwipe?.id !== e.pointerId) return;
      const dx = e.clientX - pageSwipe.x;
      const dy = e.clientY - pageSwipe.y;
      pageSwipe = null;
      if (e.type === 'pointerup' && this.zoom === 1 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) this.next();
        else this.prev();
      }
    };
    this.stage.addEventListener('pointerup', up);
    this.stage.addEventListener('pointercancel', up);

    // bàn phím
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.target.matches('input, select, textarea')) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      const k = e.key;
      if (k === 'ArrowRight' || k === 'PageDown') (e.preventDefault(), this.next());
      else if (k === 'ArrowLeft' || k === 'PageUp') (e.preventDefault(), this.prev());
      else if (k === 'Home') this.goTo(0);
      else if (k === 'End') this.goTo(this.n - 1);
      else if (k === '+' || k === '=') this.setZoom(this.zoom + 0.5);
      else if (k === '-') this.setZoom(this.zoom - 0.5);
      else if (k === '0') this.setZoom(1);
      else if (k === 'f' || k === 'F') this._toggleFull();
      else if (k === ' ' && !e.target.closest('button')) (e.preventDefault(), this.toggleVoice());
      else if (k === 'Escape') {
        if (this.panel) this.closePanel();
        else if (this.zoom > 1) this.setZoom(1);
        else if (!document.fullscreenElement && !this.book.bilingualReader) this.onClose();
      }
    });

    // đổi kích thước
    let rt;
    addEventListener('resize', () => {
      if (!this.isOpen) return;
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (!this.isOpen) return;
        this._applyZoom();
        const need = this._single();
        if (need !== this._builtSingle) this._build(this.focusedPage);
        else this.flip?.update();
      }, 180);
    });
  }
}
