require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Rcon } = require('rcon-client');
const axios = require('axios');
const cors = require('cors');

const fs = require('fs');
const path = require('path');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DATABASE_FILE = path.join(__dirname, 'recharges.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'nightmare_secret_key_2026';

// Khởi tạo file dữ liệu nếu chưa có
if (!fs.existsSync(DATABASE_FILE)) fs.writeFileSync(DATABASE_FILE, JSON.stringify([]));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));

// Middleware kiểm tra Token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Bạn chưa đăng nhập' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Phiên đăng nhập hết hạn' });
        req.user = user;
        next();
    });
};

// Hàm lưu lịch sử nạp (Local JSON)
function saveRechargeLocal(username, amount) {
    const data = JSON.parse(fs.readFileSync(DATABASE_FILE));
    const userIndex = data.findIndex(item => item.username.toLowerCase() === username.toLowerCase());
    if (userIndex !== -1) {
        data[userIndex].total += parseInt(amount);
    } else {
        data.push({ username, total: parseInt(amount), lastUpdate: new Date() });
    }
    data.sort((a, b) => b.total - a.total);
    fs.writeFileSync(DATABASE_FILE, JSON.stringify(data, null, 2));

    const history = JSON.parse(fs.readFileSync(HISTORY_FILE));
    history.unshift({ username, amount: parseInt(amount), date: new Date() });
    if (history.length > 50) history.pop(); // Tăng lên 50 bản ghi
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// Hàm gửi lệnh đến Minecraft Server qua RCON
async function executeMcCommand(command) {
    try {
        const rcon = await Rcon.connect({
            host: process.env.RCON_HOST,
            port: parseInt(process.env.RCON_PORT),
            password: process.env.RCON_PASSWORD,
        });
        const response = await rcon.send(command);
        await rcon.end();
        return response;
    } catch (err) {
        console.error('RCON Error:', err);
        throw err;
    }
}

// --- API AUTH ---

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    const users = JSON.parse(fs.readFileSync(USERS_FILE));
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ message: 'Tên tài khoản đã tồn tại' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    users.push({ username, password: hashedPassword, createdAt: new Date() });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    res.json({ status: 'success', message: 'Đăng ký thành công!' });
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const users = JSON.parse(fs.readFileSync(USERS_FILE));
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ message: 'Sai tài khoản hoặc mật khẩu' });
    }
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ status: 'success', token, username: user.username });
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    const username = req.user.username;
    try {
        const data = JSON.parse(fs.readFileSync(DATABASE_FILE));
        const userData = data.find(item => item.username.toLowerCase() === username.toLowerCase());
        const totalRecharge = userData ? userData.total : 0;

        const pointsRes = await executeMcCommand(`points look ${username}`);
        const pointsMatch = pointsRes.match(/has ([\d,.]+) points/);
        const points = pointsMatch ? pointsMatch[1] : "0";

        const rankRes = await executeMcCommand(`lp user ${username} info`);
        const rankMatch = rankRes.match(/Primary group: ([\w-]+)/);
        const rank = rankMatch ? rankMatch[1] : "Default";

        res.json({
            status: 'success',
            user: { username, points, rank, totalRecharge }
        });
    } catch (err) {
        res.json({ status: 'success', user: { username, points: '?', rank: '?', totalRecharge: 0 } });
    }
});

// Lấy lịch sử nạp cá nhân
app.get('/api/auth/transactions', authenticateToken, (req, res) => {
    const username = req.user.username;
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE));
    const userHistory = history.filter(h => h.username.toLowerCase() === username.toLowerCase());
    res.json({ status: 'success', transactions: userHistory });
});

// --- API RECHARGE ---

app.post('/api/card-recharge', async (req, res) => {
    const { user, type, amount, code, seri } = req.body;
    try {
        const response = await axios.get('https://thesieutoc.vn/card-recharge/api', {
            params: {
                api_key: process.env.THESIEUTOC_API_KEY,
                pin: code,
                seri: seri,
                type: type.toUpperCase(),
                amount: amount,
                request_id: `${user}_${Date.now()}`
            }
        });
        const data = response.data;
        if (data.status === '00' || data.status === 'success') {
            res.json({ status: 'success', message: 'Thẻ đã được gửi. Đang chờ xử lý.' });
        } else {
            res.json({ status: 'error', message: data.msg || 'Lỗi hệ thống gạch thẻ.' });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Lỗi kết nối gạch thẻ.' });
    }
});

app.post('/api/callback', async (req, res) => {
    if (req.query.token !== process.env.CALLBACK_TOKEN) return res.status(403).send('Sai mã bảo mật');
    const { status, request_id, amount } = req.body;
    const username = request_id.split('_')[0];

    if (status === 'success' || status === '1') {
        try {
            saveRechargeLocal(username, amount);
            const gameAmount = parseInt(amount);
            await executeMcCommand(`points give ${username} ${gameAmount}`);
            await executeMcCommand(`broadcast §6§l[ ★ NẠP THẺ ★ ] §fNgười chơi §b${username} §fvừa nạp thành công §a${amount.toLocaleString()}đ §fvào hệ thống!`);
            await executeMcCommand(`title ${username} title {"text":"§a§lTHANKS FOR DONATING!"}`);
            await executeMcCommand(`title ${username} subtitle {"text":"§fBạn đã nhận được §e${gameAmount.toLocaleString()} points"}`);
        } catch (err) {
            console.error('Callback Error:', err);
        }
    }
    res.send('OK');
});

// --- API PUBLIC ---

app.get('/api/player/:username', async (req, res) => {
    const { username } = req.params;
    try {
        const data = JSON.parse(fs.readFileSync(DATABASE_FILE));
        const userData = data.find(item => item.username.toLowerCase() === username.toLowerCase());
        const totalRecharge = userData ? userData.total : 0;
        const pointsRes = await executeMcCommand(`points look ${username}`);
        const pointsMatch = pointsRes.match(/has ([\d,.]+) points/);
        const points = pointsMatch ? pointsMatch[1] : "0";
        const rankRes = await executeMcCommand(`lp user ${username} info`);
        const rankMatch = rankRes.match(/Primary group: ([\w-]+)/);
        const rank = rankMatch ? rankMatch[1] : "Default";

        res.json({ status: 'success', data: { username, points, rank, totalRecharge } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Lỗi tra cứu.' });
    }
});

app.get('/api/test-rcon', async (req, res) => {
    try {
        const response = await executeMcCommand('say RCON Test Connection Success!');
        res.json({ status: 'success', server_response: response });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/top-recharge', (req, res) => {
    const data = JSON.parse(fs.readFileSync(DATABASE_FILE));
    res.json(data.slice(0, 10));
});

app.get('/api/recent-recharge', (req, res) => {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE));
    res.json(history.slice(0, 5));
});

app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
});
