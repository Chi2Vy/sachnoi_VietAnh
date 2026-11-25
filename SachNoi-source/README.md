# Sách Nói

Mã nguồn của bản HTML5 đọc sách, lật trang và nghe đọc.

- `index.template.html` chứa bố cục và đoạn khởi động ứng dụng.
- `style.css` chứa giao diện thư viện và trình đọc.
- `js/` chứa mã ứng dụng, trình đọc, nhập PDF/ảnh, giọng đọc và lưu trữ trong phiên.
- `vendor/` chứa PDF.js, PDF.js worker và thư viện lật trang.

Chạy bằng Python 3.10 trở lên, không cần cài thư viện ngoài.

```powershell
python build.py
```

Lệnh tạo `SachNoi.html` trong thư mục đang làm việc. Mở file này bằng trình duyệt.
Có thể chỉ định vị trí khác bằng `python build.py --output đường-dẫn.html`.
