// ===== THÔNG TIN BẢN QUYỀN & LIÊN HỆ — sửa tại đây =====
const APP_INFO = {
  name: 'GCloud Hub',
  author: 'Mr. Huỳnh',
  owner: 'Huỳnh Xuyên Sơn',
  slogan: 'Mọi Gmail, Drive & AI Agent của bạn — gọn trong một cửa sổ',
  year: 2026,
  contact: [
    // logo: đặt ảnh logo chính thức vào assets/logos/<key>.png để thay biểu tượng mặc định
    { key: 'zalo', label: 'Zalo', color: '#0068FF', text: 'Zalo', href: 'https://zalo.me/0979007367' },
    { key: 'email', label: 'Email', color: '#EA580C', icon: 'mail', href: 'mailto:info@mrhuynh.net' },
    { key: 'website', label: 'Website', color: '#10B981', icon: 'globe', href: 'https://mrhuynh.net' },
    { key: 'facebook', label: 'Facebook', color: '#1877F2', text: 'f', href: 'https://facebook.com/mr.huynhxuyenson' },
  ],
  // Mời cà phê (VietQR — quét bằng app ngân hàng bất kỳ)
  donate: {
    bank: 'BIDV', account: '8844588159', holder: 'HUYNH XUYEN SON',
    title: 'Mời Sơn một ly cà phê',
    text: 'Nếu GCloud Hub giúp công việc của bạn nhẹ nhàng hơn một chút, hãy mời mình một ly cà phê nhé! Mỗi ly cà phê là thêm một chút năng lượng để mình thức khuya làm thêm tính năng mới. Cảm ơn bạn thật nhiều! 💙',
  },
  // Dòng giới thiệu tính năng chạy luân phiên trên thanh tiêu đề
  highlights: [
    { icon: 'mail', text: 'Hộp thư hợp nhất — xem thư chưa đọc của mọi Gmail tại một nơi' },
    { icon: 'drive', text: 'Quản lý nhiều Google Drive với biểu đồ dung lượng trực quan' },
    { icon: 'image', text: 'Google Photos — xem, quản lý và tải ảnh lên nhiều tài khoản' },
    { icon: 'sync', text: 'Chuyển & đồng bộ dữ liệu giữa các Drive chỉ với vài cú nhấp' },
    { icon: 'spark', text: 'AI Agent — trợ lý AI ngay trong ứng dụng, dùng bằng bất kỳ tài khoản nào' },
    { icon: 'search', text: 'Tìm kiếm mọi thứ — web, hình ảnh, tin tức, video, bản đồ ngay trong ứng dụng' },
    { icon: 'shield', text: 'Không lưu mật khẩu — mỗi tài khoản một phiên đăng nhập riêng' },
  ],
};
