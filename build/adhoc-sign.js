// macOS: ký ad-hoc (không cần chứng chỉ Apple) cho ứng dụng sau khi đóng gói.
// Không ký → máy Mac (nhất là chip Apple M) báo "GCloud Hub bị hỏng, không thể mở". Ký ad-hoc → máy Mac mở được
// (lần đầu: chuột phải › Mở, hoặc Cài đặt › Quyền riêng tư & Bảo mật › Vẫn mở).
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log('  • ký ad-hoc', app);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
