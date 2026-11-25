// Nhập PDF hoặc ảnh thành các trang lật, ảnh thu nhỏ và văn bản.
import { newId, putBook, putPage, putTexts, putFile, deleteBook } from './db.js';

export const ACCEPT = {
  book: '.pdf,application/pdf,image/jpeg,image/png,image/webp',
  audio: '.mp3,.m4a,.ogg,.wav,audio/*',
};

const PAGE_MAX_EDGE = 2800;
const PAGE_MAX_PIXELS = 5_000_000;
const THUMB_MAX_EDGE = 240;

function pageScale(width, height, edgeLimit = PAGE_MAX_EDGE, pixelLimit = PAGE_MAX_PIXELS) {
  return Math.min(edgeLimit / Math.max(width, height), Math.sqrt(pixelLimit / (width * height)));
}

// Một số ảnh JPG/PNG/WebP mở được trong <img> nhưng createImageBitmap không đọc được.
// Thử cả hai cách; luôn thu hồi tài nguyên sau khi đã vẽ lên canvas.
async function openImage(file) {
  let initialError;
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      if (!bitmap.width || !bitmap.height) throw new Error('Kích thước ảnh không hợp lệ');
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
    } catch (error) { initialError = error; }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Kích thước ảnh không hợp lệ');
    return {
      source: image, width: image.naturalWidth, height: image.naturalHeight,
      release: () => { image.src = ''; URL.revokeObjectURL(url); },
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    const cause = initialError?.message || error?.message || 'Ảnh không hợp lệ';
    throw new Error(`Không thể đọc ảnh \"${file.name}\" (${cause}). Kiểm tra file có bị hỏng hoặc đổi đuôi sai định dạng không.`);
  }
}

const natural = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const toBlob = (canvas, type = 'image/jpeg', q = 0.82) => new Promise((r) => canvas.toBlob(r, type, q));

function makeThumbnail(src) {
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function readOutline(pdf) {
  let outline;
  try {
    outline = await pdf.getOutline();
  } catch {
    return [];
  }
  if (!outline) return [];
  const walk = async (items, level) => {
    const out = [];
    for (const it of items) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest)) {
          page = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0];
        }
      } catch {}
      out.push({ title: (it.title || '').trim() || 'Không tên', page, level });
      if (it.items?.length) out.push(...(await walk(it.items, level + 1)));
    }
    return out;
  };
  return walk(outline, 0);
}

async function savePage(bookId, n, canvas, text, audio, original) {
  const thumb = makeThumbnail(canvas);
  const [img, th] = await Promise.all([
    original || toBlob(canvas, 'image/webp', 0.95),
    toBlob(thumb, 'image/jpeg', 0.8),
  ]);
  if (!img || !th) throw new Error('Không thể lưu ảnh trang sách.');
  await putPage({ bookId, n, img, thumb: th, text, audio: audio || null, w: canvas.width, h: canvas.height });
  return { th, w: canvas.width, h: canvas.height };
}

/**
 * @param {{files: File[], title?: string, author?: string, audio?: File[]}} opt
 * @param {(p:{done:number,total:number,phase:string})=>void} onProgress
 */
export async function importBook(opt, onProgress = () => {}) {
  const files = [...opt.files];
  const pdfFile = files.find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const images = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name) || /^image\/(jpeg|png|webp)$/i.test(f.type)).sort(natural);
  if (!pdfFile && !images.length) throw new Error('Chưa có file hợp lệ. Chỉ nhận PDF hoặc ảnh JPG/PNG/WebP.');

  // mp3 theo trang: tên file chứa số trang (1.mp3, 02.mp3, trang-3.mp3 ...)
  const audioMap = new Map();
  for (const a of opt.audio || []) {
    const m = a.name.match(/(\d+)(?!.*\d)/);
    if (m) audioMap.set(parseInt(m[1], 10), a);
  }

  const id = opt.id || newId();
  const baseName = (pdfFile?.name || images[0]?.name || 'Sách mới').replace(/\.[^.]+$/, '');
  const book = {
    id,
    title: (opt.title || '').trim() || baseName,
    author: (opt.author || '').trim(),
    kind: pdfFile ? 'pdf' : 'images',
    pages: 0,
    pw: 3,
    ph: 4,
    hasText: false,
    outline: [],
    cover: null,
    lastPage: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    size: (pdfFile ? pdfFile.size : images.reduce((s, f) => s + f.size, 0)),
  };

  try {
    const texts = [];
    if (pdfFile) {
      onProgress({ done: 0, total: 1, phase: 'Đang mở PDF…' });
      const pdfjs = await import('../vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = window.__gs_pdf_worker;
      const data = await pdfFile.arrayBuffer();
      const pdf = await pdfjs.getDocument({
        data: data.slice(0),
        // Bản thử nhanh offline không nhúng bảng cmap riêng.
      }).promise;
      const total = pdf.numPages;
      const longBook = total >= 80;
      for (let i = 1; i <= total; i++) {
        onProgress({ done: i - 1, total, phase: `Đang xử lý trang ${i}/${total}` });
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = longBook ? pageScale(base.width, base.height, 2000, 2_800_000) : pageScale(base.width, base.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vp.width));
        canvas.height = Math.max(1, Math.round(vp.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        let text = '';
        try {
          const tc = await page.getTextContent();
          text = tc.items.map((t) => t.str + (t.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
        } catch {}
        texts.push(text);
        const a = audioMap.get(i);
        const r = await savePage(id, i, canvas, text, a ? new Blob([await a.arrayBuffer()], { type: a.type || 'audio/mpeg' }) : null);
        if (i === 1) {
          book.cover = r.th;
          book.pw = r.w;
          book.ph = r.h;
        }
        page.cleanup();
        canvas.width = canvas.height = 0;
      }
      book.pages = total;
      book.outline = await readOutline(pdf);
      await putFile(id, pdfFile, pdfFile.name);
      pdf.destroy();
    } else {
      const total = images.length;
      const skippedImages = [];
      let savedPages = 0;
      let savedBytes = 0;
      for (let i = 0; i < total; i++) {
        const file = images[i];
        onProgress({ done: i, total, phase: `Đang xử lý ảnh ${i + 1}/${total}: ${file.name}` });
        let resource;
        try {
          resource = await openImage(file);
        } catch (error) {
          // Ảnh không giải mã được chỉ bị bỏ qua. Các trang hợp lệ vẫn được nhập.
          skippedImages.push({ name: file.name, reason: error.message });
          onProgress({ done: i + 1, total, phase: `Bỏ qua ảnh lỗi: ${file.name}` });
          continue;
        }
        let canvas;
        let original;
        try {
          const ratio = Math.min(1, pageScale(resource.width, resource.height));
          if (ratio === 1) original = file;
          canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(resource.width * ratio));
          canvas.height = Math.max(1, Math.round(resource.height * ratio));
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Không thể tạo canvas để xử lý trang ảnh');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(resource.source, 0, 0, canvas.width, canvas.height);
        } finally {
          resource.release();
        }
        const pageNumber = savedPages + 1;
        const a = audioMap.get(i + 1);
        const r = await savePage(id, pageNumber, canvas, '', a ? new Blob([await a.arrayBuffer()], { type: a.type || 'audio/mpeg' }) : null, original);
        texts.push('');
        savedPages++;
        savedBytes += file.size;
        if (savedPages === 1) {
          book.cover = r.th;
          book.pw = r.w;
          book.ph = r.h;
        }
        onProgress({ done: i + 1, total, phase: `Đã nhập ${savedPages} trang, bỏ qua ${skippedImages.length} ảnh lỗi` });
      }
      if (!savedPages) {
        throw new Error(`Không ảnh nào đọc được. ${skippedImages.slice(0, 3).map(x => x.name).join(', ')}${skippedImages.length > 3 ? '…' : ''}. Kiểm tra file ảnh có bị hỏng hoặc đổi đuôi sai không.`);
      }
      book.pages = savedPages;
      book.size = savedBytes;
      // Chỉ báo cáo trong lượt nhập hiện tại, không cần lưu cảnh báo vào thư viện.
      book.importWarnings = skippedImages;
    }
    book.hasText = texts.some((t) => t.length > 10);
    await putTexts(id, texts);
    onProgress({ done: book.pages, total: book.pages, phase: 'Hoàn tất' });
    const sessionWarnings = book.importWarnings || [];
    delete book.importWarnings;
    await putBook(book);
    return { ...book, importWarnings: sessionWarnings };
  } catch (e) {
    await deleteBook(id).catch(() => {});
    throw e;
  }
}

/* ---------- Sách mẫu: tự vẽ bằng canvas, có sẵn text để thử tìm kiếm + voice ---------- */
const DEMO = [
  { h: 'Chào mừng', t: 'Đây là cuốn sách mẫu của Sách Nói. Bạn có thể lật trang bằng cách kéo góc trang, bấm hai mũi tên hai bên, hoặc dùng phím mũi tên trái phải trên bàn phím.' },
  { h: 'Tải sách của bạn', t: 'Bấm nút Tải sách lên, chọn nhiều file PDF để tạo nhiều cuốn cùng lúc, hoặc một file PDF. Mỗi trang sẽ được chuyển thành ảnh, chữ trong PDF được giữ lại để tìm kiếm và nghe đọc. Bạn cũng có thể chọn nhiều ảnh JPG hoặc PNG để làm thành một cuốn sách ảnh.' },
  { h: 'Phóng to và di chuyển', t: 'Bấm đúp vào trang để phóng to. Khi đang phóng to, hãy kéo chuột để di chuyển trang. Giữ phím Control và cuộn chuột để phóng to hoặc thu nhỏ. Trên điện thoại, dùng hai ngón tay để chụm hoặc mở rộng.' },
  { h: 'Tìm kiếm trong sách', t: 'Mở biểu tượng kính lúp ở thanh công cụ bên dưới, gõ một từ khoá, rồi chọn kết quả để nhảy tới đúng trang. Việc tìm kiếm không phân biệt chữ hoa, chữ thường và dấu tiếng Việt.' },
  { h: 'Nghe đọc bằng giọng nói', t: 'Mở biểu tượng loa, chọn giọng tiếng Việt và tốc độ phù hợp, rồi bấm Đọc từ trang này. Sách sẽ tự động lật sang trang sau khi đọc xong. Nếu một trang có file mp3 riêng, hệ thống sẽ phát file đó thay cho giọng máy.' },
  { h: 'Chúc đọc sách vui', t: 'Tiến độ đọc được lưu lại trong trình duyệt. Lần sau mở sách, bạn sẽ quay lại đúng trang đang đọc dở. Toàn bộ dữ liệu nằm trên máy của bạn, không gửi lên máy chủ nào.' },
];

function wrapText(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

export async function importDemo() {
  const id = newId();
  const W = 900, H = 1200;
  const pixelScale = 2;
  const texts = [];
  const book = {
    id, title: 'Hướng dẫn sử dụng Sách Nói', author: 'Sách mẫu', kind: 'images', pages: DEMO.length + 1,
    pw: W, ph: H, hasText: true, outline: [], cover: null, lastPage: 0, createdAt: Date.now(), updatedAt: Date.now(), size: 0,
  };
  try {
    for (let i = 0; i <= DEMO.length; i++) {
      const c = document.createElement('canvas');
      c.width = W * pixelScale; c.height = H * pixelScale;
      const x = c.getContext('2d');
      x.scale(pixelScale, pixelScale);
      let text = '';
      if (i === 0) {
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#1f6f5c'); g.addColorStop(1, '#0f3d33');
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        x.fillStyle = '#d99a1c'; x.fillRect(80, 150, 90, 8);
        x.fillStyle = '#f6f3ea'; x.font = '700 84px "Times New Roman", serif';
        wrapText(x, book.title, W - 160).forEach((l, k) => x.fillText(l, 80, 290 + k * 100));
        x.font = '28px Arial, sans-serif'; x.fillStyle = '#bfe0d5';
        x.fillText('Sách mẫu · lật trang · tìm kiếm · nghe đọc', 80, H - 110);
        text = `${book.title}. Sách mẫu, lật trang, tìm kiếm, nghe đọc.`;
        book.outline.push({ title: 'Bìa', page: 0, level: 0 });
      } else {
        const d = DEMO[i - 1];
        x.fillStyle = '#fbf8f1'; x.fillRect(0, 0, W, H);
        x.fillStyle = '#d99a1c'; x.fillRect(90, 120, 60, 6);
        x.fillStyle = '#1d2a2e'; x.font = '700 56px "Times New Roman", serif';
        x.fillText(d.h, 90, 210);
        x.font = '34px Arial, sans-serif';
        wrapText(x, d.t, W - 180).forEach((l, k) => x.fillText(l, 90, 320 + k * 56));
        x.fillStyle = '#8a8f87'; x.font = '22px Arial, sans-serif';
        x.fillText(String(i + 1), i % 2 ? W - 120 : 90, H - 70);
        text = `${d.h}. ${d.t}`;
        book.outline.push({ title: d.h, page: i, level: 0 });
      }
      texts.push(text);
      const r = await savePage(id, i + 1, c, text, null);
      if (i === 0) book.cover = r.th;
    }
    book.size = 0;
    await putTexts(id, texts);
    await putBook(book);
    return book;
  } catch (e) {
    await deleteBook(id).catch(() => {});
    throw e;
  }
}
