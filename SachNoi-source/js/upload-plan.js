// Phân nhóm tệp trước khi nhập: mỗi PDF thành một cuốn, toàn bộ ảnh thành một cuốn.
// Tách riêng để logic chọn nhiều tệp có thể kiểm thử không cần trình duyệt.
export const isPdf = (file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
export const isImage = (file) => /\.(jpe?g|png|webp)$/i.test(file.name) || /^image\/(jpeg|png|webp)$/i.test(file.type);
export const isBookFile = (file) => isPdf(file) || isImage(file);

export function createImportJobs(files) {
  const pdfs = files.filter(isPdf);
  const images = files.filter((f) => !isPdf(f) && isImage(f));
  const jobs = pdfs.map((file) => ({ files: [file], name: file.name, kind: 'pdf' }));
  if (images.length) jobs.push({ files: images, name: `Sách ảnh (${images.length} trang)`, kind: 'images' });
  return jobs;
}

// Giữ các file đã chọn khi người dùng mở hộp chọn tệp nhiều lần.
export function addUniqueFiles(current, incoming) {
  const result = [...current];
  const keys = new Set(result.map((f) => `${f.name}\0${f.size}\0${f.lastModified}\0${f.type}`));
  for (const file of incoming) {
    const key = `${file.name}\0${file.size}\0${file.lastModified}\0${file.type}`;
    if (!keys.has(key)) { keys.add(key); result.push(file); }
  }
  return result;
}
