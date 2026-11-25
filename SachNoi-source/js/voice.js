// Giọng đọc: (1) mp3 gắn theo trang nếu có, (2) Text-to-Speech của trình duyệt (Web Speech API) đọc text của trang.
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;

export const LANGUAGES = {
  'vi-VN': { label: 'Tiếng Việt', prefixes: ['vi'] },
  'en-US': { label: 'Tiếng Anh', prefixes: ['en'] },
  'zh-CN': { label: 'Tiếng Trung', prefixes: ['zh', 'cmn', 'yue'] },
};
const locale = (value) => value.toLowerCase().replaceAll('_', '-');
const languageKey = 'gs.voiceLanguage';

export function splitSentences(text, max = 160) {
  const raw = text.replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const parts = raw.match(/[^.!?…。！？;；:：]+[.!?…。！？;；:：]*|[.!?…。！？;；:：]+/gu) || [raw];
  const out = [];
  for (let p of parts) {
    p = p.trim();
    while (p.length > max) {
      let cut = p.lastIndexOf(' ', max);
      if (cut < 40) cut = max;
      out.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (p) out.push(p);
  }
  return out;
}

export class Voice {
  constructor() {
    this.supported = !!synth;
    this.voices = [];
    const savedLanguage = localStorage.getItem(languageKey);
    this.language = Object.hasOwn(LANGUAGES, savedLanguage) ? savedLanguage : 'vi-VN';
    this.rate = parseFloat(localStorage.getItem('gs.rate') || '1');
    this.pitch = 1;
    this.token = 0; // huỷ tác vụ cũ
    this.audio = new Audio();
    this.cancelPending = null;
    this.playPendingAudio = null;
    this.state = 'idle'; // idle | playing | paused
    this.onState = () => {};
    this.onChunk = () => {};
    this._load();
    if (synth) synth.addEventListener?.('voiceschanged', () => this._load());
  }

  _load() {
    if (!synth) return;
    this.voices = synth.getVoices();
    this.onVoices?.(this.voices);
  }

  get languageVoices() {
    const { prefixes } = LANGUAGES[this.language];
    return this.voices.filter((voice) => prefixes.includes(locale(voice.lang).split('-')[0]));
  }

  pickVoice() {
    const available = this.languageVoices;
    const preferred = localStorage.getItem(`gs.voice.${this.language}`) || localStorage.getItem('gs.voice');
    return available.find((voice) => voice.voiceURI === preferred)
      || available.find((voice) => locale(voice.lang) === locale(this.language))
      || available[0]
      || null;
  }

  setLanguage(language) {
    if (!Object.hasOwn(LANGUAGES, language)) return;
    this.language = language;
    localStorage.setItem(languageKey, language);
    this.onVoices?.(this.voices);
  }

  setVoice(uri) {
    if (this.languageVoices.some((voice) => voice.voiceURI === uri)) {
      localStorage.setItem(`gs.voice.${this.language}`, uri);
    }
  }
  setRate(r) {
    this.rate = r;
    localStorage.setItem('gs.rate', String(r));
    if (this.audio) this.audio.playbackRate = r;
  }

  _set(s) {
    this.state = s;
    this.onState(s);
  }

  /** Đọc 1 trang. Resolve true nếu đọc xong tự nhiên, false nếu bị dừng/huỷ. */
  async speakPage({ text, audioBlob }) {
    this.stop(true);
    const my = ++this.token;
    this._set('playing');
    try {
      if (audioBlob) {
        this.onChunk({ kind: 'audio', text: 'Đang phát file âm thanh của trang' });
        if (my !== this.token) return false;
        return (await this._playAudio(audioBlob)) && my === this.token;
      }
      if (!synth) throw new Error('Trình duyệt không hỗ trợ đọc văn bản (Web Speech API).');
      const voice = this.pickVoice();
      const label = LANGUAGES[this.language].label;
      if (!voice && this.voices.length) throw new Error(`Thiết bị chưa có giọng ${label}. Hãy thêm giọng này trong cài đặt thiết bị.`);
      if (synth.paused) synth.resume();
      const chunks = splitSentences(text || '');
      for (let i = 0; i < chunks.length; i++) {
        if (my !== this.token) return false;
        this.onChunk({ kind: 'text', text: chunks[i], index: i, total: chunks.length, all: chunks });
        const err = await this._utter(chunks[i], my, voice);
        if (err && my === this.token) throw new Error(`Không đọc được bằng giọng ${label} (${err}). Hãy kiểm tra giọng trong cài đặt thiết bị.`);
      }
      return my === this.token;
    } finally {
      if (my === this.token) this._set('idle');
    }
  }

  _playAudio(source) {
    return new Promise((resolve, reject) => {
      const audio = this.audio;
      const objectUrl = source instanceof Blob;
      const url = objectUrl ? URL.createObjectURL(source) : source;
      let done = false;
      const finish = (completed, error) => {
        if (done) return;
        done = true;
        this.cancelPending = null;
        this.playPendingAudio = null;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        if (objectUrl) URL.revokeObjectURL(url);
        if (error) reject(new Error('Không phát được file âm thanh'));
        else resolve(completed);
      };
      const play = () => audio.play().catch((error) => {
        if (error.name !== 'AbortError') finish(false, error);
      });
      this.cancelPending = () => finish(false);
      this.playPendingAudio = play;
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false, audio.error);
      try {
        audio.src = url;
        audio.playbackRate = this.rate;
        play();
      } catch (error) {
        finish(false, error);
      }
    });
  }

  _utter(text, my, voice) {
    return new Promise((res) => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || this.language;
      u.rate = this.rate;
      u.pitch = this.pitch;
      let done = false;
      const fin = (err) => {
        if (!done) {
          done = true;
          clearInterval(keep);
          this.cancelPending = null;
          u.onend = null;
          u.onerror = null;
          res(err && !/^(canceled|interrupted)$/.test(err) ? err : null);
        }
      };
      u.onend = () => fin();
      u.onerror = (ev) => fin(ev.error);
      // Chrome đôi khi dừng im lặng khi nói lâu: "đánh thức" định kỳ
      const keep = setInterval(() => {
        if (my !== this.token) return fin();
        if (synth.speaking && !synth.paused) {
          synth.pause();
          synth.resume();
        }
      }, 10000);
      this.cancelPending = () => fin();
      synth.speak(u);
    });
  }

  pause() {
    if (this.state !== 'playing') return;
    if (this.playPendingAudio) this.audio.pause();
    else synth?.pause();
    this._set('paused');
  }
  resume() {
    if (this.state !== 'paused') return;
    if (this.playPendingAudio) this.playPendingAudio();
    else synth?.resume();
    this._set('playing');
  }
  stop(silent = false) {
    this.token++;
    this.cancelPending?.();
    synth?.cancel();
    if (!silent) this._set('idle');
  }
}
