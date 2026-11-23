# GCloud Hub by Mr. Huỳnh

© 2026 Huỳnh Xuyên Sơn (Mr. Huỳnh) · Zalo 0979 007 367 · info@mrhuynh.net · mrhuynh.net

Ứng dụng Windows quản lý nhiều tài khoản Gmail / email doanh nghiệp, nhiều Google Drive, Gemini và Google Search trong một cửa sổ — **không dùng Google API**, không cần tạo Client ID.

## Cách hoạt động
- **Thêm tài khoản** → ứng dụng mở cửa sổ đăng nhập thật của Google / Microsoft / Zoho / webmail công ty. Đăng nhập như bình thường (có hỗ trợ xác minh 2 bước). Ứng dụng **không lưu mật khẩu**.
- Mỗi tài khoản có **phiên trình duyệt riêng** (cookie riêng), nên nhiều tài khoản chạy song song mà không bị lẫn.
- Sau khi đăng nhập, mọi thao tác chạy **ngầm trong cửa sổ ẩn** hoặc nhúng ngay trong giao diện ứng dụng.

## Tính năng
| Mục | Mô tả |
|---|---|
| Tổng quan | Thẻ KPI, biểu đồ so sánh dung lượng (% hạn mức), biểu đồ tròn Drive/Gmail/Photos cho từng tài khoản, thư mới nhất |
| Thư | Hộp thư chưa đọc **hợp nhất** từ mọi Gmail, đọc/trả lời trong giao diện webmail nhúng, **Soạn thư nhanh** gửi ngầm từ bất kỳ tài khoản Gmail/Outlook nào (Gmail hỗ trợ đính kèm), thông báo Windows khi có thư mới |
| Google Drive | Chuyển nhanh giữa các Drive, thanh dung lượng |
| Đồng bộ Drive | **Chuyển tệp giữa tài khoản**: tải xuống từ Drive nguồn → hàng chờ → tải lên ngầm vào một hoặc nhiều Drive đích (có thể chọn thư mục đích). **Đồng bộ thư mục máy tính** → nhiều Drive theo lịch (15 phút … mỗi ngày), chỉ tải tệp mới/đã sửa |
| Gemini | Dùng Gemini bằng tài khoản bất kỳ đã đăng nhập |
| Google Search | Tìm kiếm Web/Hình ảnh/Tin tức/Video/Bản đồ, ẩn danh hoặc theo tài khoản |
| Cài đặt | Giao diện tối/sáng, đổi tên/màu tài khoản, đăng nhập lại, gỡ tài khoản |

## Chạy / build
- Dùng ngay: chạy `GCloudHub-Portable-1.0.0.exe` (không cần cài đặt).
- Chạy từ mã nguồn: cài Node.js 20+, chạy `run-dev.bat`.
- Tự build `.exe` (portable + bộ cài đặt): chạy `build-windows.bat` → kết quả trong `dist\`.
- Hoặc đẩy lên GitHub — workflow `.github/workflows/build.yml` tự build trên Windows.

## Lưu ý
- Nếu Google báo *"Trình duyệt hoặc ứng dụng này có thể không an toàn"*: vào **Cài đặt → Nhận dạng trình duyệt khi đăng nhập** → chọn **Firefox**, rồi thêm lại tài khoản.
- Đọc dung lượng, gửi thư và tải lên Drive hoạt động bằng cách điều khiển giao diện web của Google; nếu Google thay đổi giao diện, các chức năng này có thể cần cập nhật.
- Tệp trong thư mục con của tác vụ đồng bộ được tải lên cùng một thư mục Drive đích; thư mục Drive tải xuống sẽ ở dạng .zip.
- Dữ liệu ứng dụng: `%APPDATA%\GCloud Hub\`.
- Thông tin bản quyền, liên hệ, slogan: sửa trong `src/renderer/about.js`. Logo chính thức của Zalo/Facebook: đặt `zalo.png`, `facebook.png` vào `assets/logos/` rồi build lại.

## Cấu trúc
```
src/main/      main.js (cửa sổ, IPC) · accounts.js (đăng nhập) · browser.js (phiên & cửa sổ ẩn)
               google.js (thư chưa đọc, dung lượng, gửi thư, tải lên Drive) · transfer.js (hàng chờ, đồng bộ)
src/renderer/  index.html · styles.css · app.js · icons.js
```

## Cập nhật online (phát hành phiên bản mới)
Ứng dụng tự kiểm tra `https://mrhuynh.net/gcloudhub/latest.json` khi mở và mỗi 6 giờ (đổi địa chỉ ở `updateUrl` trong `package.json`).
1. Tăng `version` trong `package.json` (ví dụ 1.0.0 → 1.1.0).
2. Build: chạy `build-windows.bat`.
3. Tạo latest.json: `node tools/make-latest.js "• Nội dung thay đổi 1\n• Nội dung thay đổi 2"`.
4. Tải lên thư mục `https://mrhuynh.net/gcloudhub/` 3 tệp: `latest.json`, `GCloudHub-Portable-x.y.z.exe`, `GCloudHub-Setup-x.y.z.exe`.
Người dùng sẽ thấy thông báo "Có phiên bản mới" → bấm **Cập nhật ngay** → ứng dụng tải về, kiểm tra mã SHA-256 (chống tệp giả mạo), thay tệp và tự khởi động lại.
Đặt `"mandatory": true` trong latest.json để bắt buộc cập nhật.
