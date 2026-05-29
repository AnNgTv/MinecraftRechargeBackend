const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// --- CẤU HÌNH ---
const PROJECT_DIR = '/data/data/com.termux/files/home/MinecraftWeb';
const BACKEND_DIR = '/data/data/com.termux/files/home/recharge-backend';
const CONFIG_PATH = path.join(PROJECT_DIR, 'assets/js/config.js');

console.log('🚀 Đang khởi động hệ thống tự động...');

// 1. Khởi động Backend (nếu chưa chạy)
exec('pkill -f "node index.js"', () => {
    const backend = exec('node index.js', { cwd: BACKEND_DIR });
    backend.stdout.on('data', (data) => console.log(`[Backend]: ${data.trim()}`));
});

// 2. Khởi động Serveo và lấy Link
console.log('🌐 Đang tạo link tunnel qua Serveo...');
const serveo = exec('ssh -R 80:localhost:3000 serveo.net');

serveo.stdout.on('data', (data) => {
    // Tìm link trong output (dạng https://*.serveousercontent.com)
    const match = data.match(/https:\/\/[a-zA-Z0-9-]+\.serveousercontent\.com/);
    if (match) {
        const newLink = match[0];
        console.log(`✅ Đã có link mới: ${newLink}`);

        // 3. Cập nhật vào config.js
        let content = fs.readFileSync(CONFIG_PATH, 'utf8');
        const regex = /const API_BASE = 'https:\/\/.*?';/;
        const newContent = content.replace(regex, `const API_BASE = '${newLink}';`);
        
        if (content !== newContent) {
            fs.writeFileSync(CONFIG_PATH, newContent);
            console.log('📝 Đã cập nhật link vào assets/js/config.js');

            // 4. Push lên GitHub
            console.log('☁️ Đang đẩy lên GitHub...');
            exec(`git add . && git commit -m "Auto-update API link: ${newLink}" && git push origin main`, { cwd: PROJECT_DIR }, (err, stdout) => {
                if (err) console.error('❌ Lỗi Git:', err);
                else {
                    console.log('🎉 Hoàn tất! Trang web đã sẵn sàng tại: https://anngtv.github.io/MinecraftWeb/');
                }
            });
        } else {
            console.log('ℹ️ Link không thay đổi, bỏ qua cập nhật GitHub.');
        }
    }
});

serveo.stderr.on('data', (data) => {
    if (data.includes('Forwarding HTTP traffic')) return;
    console.error(`[Serveo Error]: ${data}`);
});
