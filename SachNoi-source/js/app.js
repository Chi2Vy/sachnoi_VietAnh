import * as DB from './db.js';
import { importBook, importDemo, ACCEPT } from './importer.js';
import { Reader } from './reader.js';
import { isBookFile, createImportJobs, addUniqueFiles } from './upload-plan.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

/* ---------- toast ---------- */
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3200);
}

/* ---------- theme ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('gs.theme', t); } catch {}
  $('#themeBtn use').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
}
$('#themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
applyTheme(document.documentElement.dataset.theme || 'light');

/* ---------- reader & router ---------- */
const reader = new Reader({ toast, onClose: () => (location.hash = '#/library') });

const featuredBook = {
  id: 'goc-ha-noi-viet-anh',
  title: 'Góc Hà Nội – Việt Anh',
  author: '',
  kind: 'pdf',
  pages: 54,
  size: 81216729,
  lastPage: 0,
};
const featuredCover = 'data:image/jpeg;base64,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';
const separateVoicePages = new Set([2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30, 32, 33, 34, 35, 36, 37, 39, 40, 41, 42, 43, 44, 46, 47, 48]);
let featuredLoading;

async function loadFeaturedBook() {
  const existing = await DB.getBook(featuredBook.id);
  if (existing) return existing;
  featuredLoading ??= (async () => {
    toast('Đang mở Góc Hà Nội – Việt Anh…');
    const script = document.createElement('script');
    script.src = new URL('books/goc-ha-noi-viet-anh.js', document.baseURI).href;
    let encoded;
    try {
      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = () => reject(new Error('Không tìm thấy tệp sách Góc Hà Nội trong thư mục books.'));
        document.head.append(script);
      });
      encoded = globalThis.__gsGocHaNoiPdf;
      if (!Array.isArray(encoded)) throw new Error('Tệp sách Góc Hà Nội bị lỗi.');
    } finally {
      delete globalThis.__gsGocHaNoiPdf;
      script.remove();
    }
    const parts = encoded.map((chunk) => Uint8Array.from(atob(chunk), (char) => char.charCodeAt(0)));
    const file = new File(parts, 'GocHaNoi - VietAnh Ver14.pdf', { type: 'application/pdf' });
    if (file.size !== featuredBook.size) throw new Error('Tệp sách Góc Hà Nội chưa đủ dung lượng.');
    const book = await importBook({ id: featuredBook.id, title: featuredBook.title, files: [file] }, ({ phase }) => toast(phase));
    await DB.patchBook(book.id, { bilingualReader: true });
    for (const page of await DB.getPages(book.id)) {
      if (page.n >= 2 && page.n <= 53) {
        const audioUrl = (name) => new URL(`books/goc-ha-noi-viet-anh-audio/${name}.mp3`, document.baseURI).href;
        page.audio = audioUrl(page.n);
        page.voiceTracks = separateVoicePages.has(page.n)
          ? { vi: audioUrl(`p${2 * page.n - 2}`), en: audioUrl(`p${2 * page.n - 1}`) }
          : { both: page.audio };
      }
    }
    return book;
  })().finally(() => { featuredLoading = null; });
  return featuredLoading;
}

let routeVersion = 0;

async function route() {
  const version = ++routeVersion;
  const m = location.hash.match(/^#\/read\/([^/]+)(?:\/(\d+))?/);
  if (!m && location.hash !== '#/library') {
    location.replace(`#/read/${featuredBook.id}`);
    return;
  }
  if (m) {
    $('#view-library').hidden = true;
    if (reader.isOpen && reader.book.id === m[1]) {
      if (m[2]) reader.goTo(Number(m[2]) - 1, { fromHistory: true });
      return;
    }
    let book;
    try {
      book = m[1] === featuredBook.id ? await loadFeaturedBook() : await DB.getBook(m[1]);
    } catch (error) {
      if (version !== routeVersion) return;
      location.hash = '#/library';
      toast(error.message);
      return;
    }
    if (version !== routeVersion) return;
    const startPage = m[2] ? Number(m[2]) - 1 : book?.lastPage || 0;
    const ok = book && await reader.open(m[1], startPage);
    if (!ok) {
      toast('Không tìm thấy sách này.');
      location.hash = '#/library';
    }
  } else {
    if (reader.isOpen) reader.close();
    $('#view-library').hidden = false;
    renderLibrary();
  }
}
addEventListener('hashchange', route);

/* ---------- thư viện ---------- */
let books = [];
let coverUrls = [];

async function renderLibrary() {
  books = await DB.listBooks();
  const featured = books.find((book) => book.id === featuredBook.id) || featuredBook;
  books = [featured, ...books.filter((book) => book.id !== featuredBook.id)];
  draw();
}

function draw() {
  coverUrls.forEach((u) => URL.revokeObjectURL(u));
  coverUrls = [];
  const q = $('#libSearch').value.trim().toLowerCase();
  const list = q ? books.filter((b) => (b.title + ' ' + b.author).toLowerCase().includes(q)) : books;
  const shelf = $('#shelf');
  shelf.innerHTML = '';
  $('#empty').hidden = books.length > 0;
  $('#heroStats').hidden = !books.length;
  $('#stBooks').textContent = books.length;
  $('#stPages').textContent = books.reduce((s, b) => s + b.pages, 0);
  $('#stSize').textContent = fmtSize(books.reduce((s, b) => s + (b.size || 0), 0));
  if (books.length && !list.length) shelf.innerHTML = `<p class="hint">Không có sách nào khớp “${esc(q)}”.</p>`;

  for (const b of list) {
    const fixed = b.id === featuredBook.id;
    const cover = fixed ? featuredCover : b.cover ? URL.createObjectURL(b.cover) : '';
    if (!fixed && cover) coverUrls.push(cover);
    const pct = b.pages > 1 ? Math.round((b.lastPage / (b.pages - 1)) * 100) : 0;
    const a = document.createElement('article');
    a.className = 'book-card';
    a.innerHTML = `
      <a class="cover" href="#/read/${b.id}" aria-label="Đọc ${esc(b.title)}">
        ${cover ? `<img src="${cover}" alt="" loading="lazy" />` : ''}
        <span class="badges">${b.hasText ? '<span class="badge">Chữ</span>' : ''}<span class="badge">${b.kind === 'pdf' ? 'PDF' : 'Ảnh'}</span></span>
      </a>
      <div class="card-actions">
        <button data-edit title="Sửa thông tin"><svg class="ic"><use href="#i-edit"/></svg></button>
        <button data-del title="Xoá sách"><svg class="ic"><use href="#i-trash"/></svg></button>
      </div>
      <div class="book-meta">
        <h3>${esc(b.title)}</h3>
        <p>${b.author ? esc(b.author) + ' · ' : ''}${b.pages} trang · ${fmtSize(b.size || 0)}</p>
        <div class="prog" title="Đã đọc ${pct}%"><i style="width:${pct}%"></i></div>
      </div>`;
    if (fixed) $('.card-actions', a).hidden = true;
    $('[data-del]', a).onclick = async () => {
      if (!confirm(`Xoá “${b.title}” khỏi thư viện?\nSách chỉ bị xoá trong trình duyệt này.`)) return;
      await DB.deleteBook(b.id);
      toast('Đã xoá sách');
      renderLibrary();
    };
    $('[data-edit]', a).onclick = () => openEdit(b);
    shelf.append(a);
  }
}
$('#libSearch').addEventListener('input', draw);

/* ---------- sửa thông tin ---------- */
const dlgEdit = $('#dlgEdit');
let editing = null;
function openEdit(b) {
  editing = b;
  $('#edTitle').value = b.title;
  $('#edAuthor').value = b.author || '';
  dlgEdit.showModal();
}
$('#editForm').addEventListener('submit', async () => {
  if (!editing) return;
  await DB.patchBook(editing.id, { title: $('#edTitle').value.trim() || editing.title, author: $('#edAuthor').value.trim() });
  editing = null;
  renderLibrary();
});

/* ---------- hộp thoại tải sách ---------- */
const dlg = $('#dlgUpload');
const dz = $('#dropzone');
let pickedBook = [];
let pickedAudio = [];
let busy = false;

const isAudio = (f) => f.type.startsWith('audio/') || /\.(mp3|m4a|ogg|wav|aac)$/i.test(f.name);

function setPicked(files) {
  if (busy) return;
  const all = [...files];
  const bookFiles = all.filter(isBookFile);
  const audioFiles = all.filter(isAudio);
  const bad = all.length - bookFiles.length - audioFiles.length;
  pickedBook = addUniqueFiles(pickedBook, bookFiles);
  pickedAudio = addUniqueFiles(pickedAudio, audioFiles);
  renderPicked();
  const err = $('#upError');
  if (bad > 0) {
    err.hidden = false;
    err.textContent = `${bad} file bị bỏ qua vì sai định dạng (chỉ nhận PDF, JPG, PNG, WebP và âm thanh).`;
  } else err.hidden = true;
  if (pickedBook.length) $('#upTitle').placeholder = pickedBook[0].name.replace(/\.[^.]+$/, '');
}

function renderPicked() {
  const jobs = createImportJobs(pickedBook);
  const nPdf = jobs.filter((job) => job.kind === 'pdf').length;
  const nImg = pickedBook.length - nPdf;
  $('#uploadSummary').textContent = pickedBook.length
    ? `Đã chọn ${pickedBook.length} file · sẽ tạo ${jobs.length} cuốn sách (${nPdf} PDF${nImg ? ` + ${nImg} ảnh ghép thành 1 cuốn` : ''}).`
    : 'Chọn nhiều PDF để tạo nhiều cuốn, hoặc chọn nhiều ảnh để ghép thành một cuốn.';
  $('#fileList').innerHTML = pickedBook
    .slice(0, 100)
    .map((f, i) => `<li><span class="filename" title="${esc(f.name)}">${esc(f.name)}</span><span class="filesize">${fmtSize(f.size)}</span><button type="button" class="file-remove" data-remove-file="${i}" aria-label="Bỏ file ${esc(f.name)}" ${busy ? 'disabled' : ''}>×</button></li>`)
    .join('') + (pickedBook.length > 100 ? `<li><span>… và ${pickedBook.length - 100} file nữa</span></li>` : '');
  $('#upTitle').disabled = busy || jobs.length > 1;
  $('#upAuthor').disabled = busy;
  $('#fileBook').disabled = busy;
  $('#fileAudio').disabled = busy || jobs.length > 1;
  $('#upTitleLabel').textContent = jobs.length > 1 ? 'Tên sách (tự lấy theo từng PDF)' : 'Tên sách';
  $('#upTitleHelp').textContent = jobs.length > 1
    ? 'Mỗi PDF được đặt theo tên file. Có thể đổi tên từng cuốn sau khi nhập.'
    : '';
  $('#audioInfo').textContent = jobs.length > 1
    ? 'Âm thanh theo trang chỉ dùng khi nhập một cuốn mỗi lần.'
    : (pickedAudio.length ? `Đã chọn ${pickedAudio.length} file âm thanh` : '');
  $('#upSubmit').disabled = !jobs.length || busy;
  $('#upSubmit').textContent = jobs.length > 1 ? `Thêm ${jobs.length} cuốn vào thư viện` : 'Thêm vào thư viện';
  $$('[data-close]', dlg).forEach((button) => button.disabled = busy);
}
$('#fileList').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-remove-file]');
  if (!btn || busy) return;
  pickedBook.splice(Number(btn.dataset.removeFile), 1);
  $('#upError').hidden = true;
  renderPicked();
});

function openUpload(files) {
  if (busy) return;
  pickedBook = [];
  pickedAudio = [];
  $('#upTitle').value = '';
  $('#upTitle').placeholder = 'Tự lấy từ tên file';
  $('#upAuthor').value = '';
  $('#upError').hidden = true;
  $('#upError').classList.remove('warning');
  $('#upProgress').hidden = true;
  $('#upBar').style.width = '0%';
  renderPicked();
  if (!dlg.open) dlg.showModal();
  if (files?.length) setPicked(files);
}
$('#openUpload').onclick = () => openUpload();
$$('[data-open-upload]').forEach((b) => (b.onclick = () => openUpload()));
$$('[data-close]').forEach((b) => (b.onclick = () => { if (!busy) b.closest('dialog').close(); }));
dlg.addEventListener('cancel', (e) => busy && e.preventDefault());

$('#fileBook').accept = ACCEPT.book;
$('#fileAudio').accept = ACCEPT.audio;
dz.onclick = () => { if (!busy) $('#fileBook').click(); };
dz.onkeydown = (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !busy) {
    e.preventDefault();
    $('#fileBook').click();
  }
};
$('#fileBook').onchange = (e) => {
  setPicked(e.target.files);
  e.target.value = '';
};
$('#fileAudio').onchange = (e) => {
  if (!busy) pickedAudio = addUniqueFiles(pickedAudio, [...e.target.files].filter(isAudio));
  renderPicked();
  e.target.value = '';
};
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), !busy && dz.classList.add('over'))));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), dz.classList.remove('over'))));
dz.addEventListener('drop', (e) => {
  e.stopPropagation();
  if (!busy) setPicked(e.dataTransfer.files);
});

$('#upForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const jobs = createImportJobs(pickedBook);
  if (!jobs.length) return;
  busy = true;
  renderPicked();
  $('#upError').hidden = true;
  $('#upError').classList.remove('warning');
  $('#upProgress').hidden = false;
  $('#upBar').style.width = '0%';
  const successes = [];
  const failures = [];
  try {
    navigator.storage?.persist?.().catch?.(() => {});
    // Tránh dùng nhầm âm thanh của lượt nhập nhiều cuốn khi thử lại một file lỗi.
    if (jobs.length > 1) pickedAudio = [];
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      $('#upPhase').textContent = `Cuốn ${i + 1}/${jobs.length}: ${job.name} — Đang mở…`;
      try {
        const book = await importBook(
          {
            files: job.files,
            // Tên tùy chỉnh / giọng đọc theo trang chỉ áp dụng cho một cuốn.
            title: jobs.length === 1 ? $('#upTitle').value : '',
            author: $('#upAuthor').value,
            audio: jobs.length === 1 ? pickedAudio : [],
          },
          ({ done, total, phase }) => {
            const fraction = total ? Math.min(1, Math.max(0, done / total)) : 0;
            $('#upBar').style.width = `${Math.round(((i + fraction) / jobs.length) * 100)}%`;
            $('#upPhase').textContent = `Cuốn ${i + 1}/${jobs.length}: ${job.name} — ${phase}`;
          }
        );
        successes.push(book);
      } catch (error) {
        console.error(`Lỗi nhập ${job.name}:`, error);
        failures.push({ job, error });
      }
      $('#upBar').style.width = `${Math.round(((i + 1) / jobs.length) * 100)}%`;
    }
    await renderLibrary();
    const imageWarnings = successes.flatMap(book => (book.importWarnings || []).map(warning => ({ book, warning })));
    if (!failures.length && !imageWarnings.length) {
      dlg.close();
      toast(successes.length === 1
        ? `Đã thêm “${successes[0].title}” (${successes[0].pages} trang)`
        : `Đã thêm thành công ${successes.length} cuốn sách!`);
    } else {
      // Chỉ giữ file nhập lỗi để thử lại; không nhập lặp các cuốn đã lưu.
      pickedBook = failures.flatMap(({ job }) => job.files);
      $('#upError').hidden = false;
      $('#upError').classList.toggle('warning', !!imageWarnings.length && !failures.length);
      const errors = failures.slice(0, 3).map(({ job, error }) => {
        const detail = /Quota|storage/i.test(error?.message || error?.name || '')
          ? 'Không đủ dung lượng lưu trữ trình duyệt'
          : (error?.message || 'File hỏng, bị khóa hoặc không đọc được');
        return `${job.name}: ${detail}`;
      });
      const skipped = imageWarnings.slice(0, 5).map(({ warning }) => warning.name);
      const descriptions = [];
      if (failures.length) descriptions.push(`${failures.length} cuốn lỗi: ${errors.join(' | ')}${failures.length > 3 ? ' | …' : ''}`);
      if (imageWarnings.length) descriptions.push(`Đã bỏ qua ${imageWarnings.length} ảnh không đọc được (${skipped.join(', ')}${imageWarnings.length > 5 ? ', …' : ''}). Các trang ảnh còn lại đã được lưu.`);
      $('#upError').textContent = `Đã nhập ${successes.length}/${jobs.length} cuốn. ${descriptions.join(' ')}`;
      if (successes.length) toast(`Đã lưu ${successes.length} cuốn${imageWarnings.length ? `; bỏ qua ${imageWarnings.length} ảnh lỗi` : ''}.`);
    }
  } finally {
    busy = false;
    renderPicked();
    if (failures.length || successes.some(b => b.importWarnings?.length)) $('#upPhase').textContent = `Hoàn tất: ${successes.length} cuốn thành công, ${failures.length} cuốn lỗi, ${successes.reduce((sum, b) => sum + (b.importWarnings?.length || 0), 0)} ảnh bị bỏ qua.`;
  }
});

/* ---------- kéo thả file vào cả trang thư viện ---------- */
let dragDepth = 0;
const lib = $('#view-library');
const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || reader.isOpen || dlg.open) return;
  dragDepth++;
  $('#dropVeil').hidden = false;
});
addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#dropVeil').hidden = true;
});
addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropVeil').hidden = true;
  if (reader.isOpen || dlg.open) return;
  openUpload(e.dataTransfer.files);
});

/* ---------- sách mẫu ---------- */
$('#demoBtn').onclick = async () => {
  $('#demoBtn').disabled = true;
  try {
    await importDemo();
    toast('Đã tạo sách mẫu');
    renderLibrary();
  } catch (e) {
    console.error(e);
    toast('Không tạo được sách mẫu: ' + e.message);
  }
  $('#demoBtn').disabled = false;
};

route();
