// Gửi tín hiệu IPC AN TOÀN chỉ tới cửa sổ chính (không gửi tới các cửa sổ ẩn đang bị hủy).
// Tránh lỗi "Object has been destroyed" khi một cửa sổ ẩn (tải/đọc Drive) bị đóng giữa chừng.
let mainWin = null;

function setMain(w) {
  mainWin = w;
}

function mainWindow() {
  try {
    if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
      return mainWin;
    }
    const { BrowserWindow } = require('electron');
    // dự phòng: cửa sổ hiển thị, còn sống (cửa sổ ẩn có show:false nên bị loại)
    return BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed() && w.isVisible()
    ) || null;
  } catch {
    return null;
  }
}

function toMain(channel, payload) {
  try {
    const w = mainWindow();
    if (w) w.webContents.send(channel, payload);
  } catch {
    // cửa sổ vừa bị hủy — bỏ qua, không làm sập tiến trình chính
  }
}

module.exports = { setMain, toMain, mainWindow };
