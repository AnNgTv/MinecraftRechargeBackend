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
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DATABASE_FILE = path.join(__dirname, 'recharges.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const RECHARGE_TX_FILE = path.join(__dirname, 'recharge-transactions.json');
const JWT_SECRET = process.env.JWT_SECRET || 'nightmare_secret_key_2026';

// Cấu hình MySQL (AuthMe)
const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'authme',
    password: process.env.DB_PASS || '12345',
    database: process.env.DB_NAME || 'authme'
};

const pool = mysql.createPool(dbConfig);

// Helper check password AuthMe ($SHA$salt$hash)
function verifyAuthMePassword(password, storedHash) {
    if (!storedHash) return false;
    const parts = storedHash.split('$');
    if (parts.length === 4 && parts[1] === 'SHA') {
        const salt = parts[2];
        const hash = parts[3];
        const computedHash = crypto.createHash('sha256').update(
            crypto.createHash('sha256').update(password).digest('hex') + salt
        ).digest('hex');
        return computedHash === hash;
    }
    // Hỗ trợ BCrypt nếu AuthMe cấu hình BCrypt
    if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
        return bcrypt.compareSync(password, storedHash);
    }
    return false;
}

// Helper tạo hash AuthMe ($SHA$salt$hash)
function hashAuthMePassword(password) {
    const salt = crypto.randomBytes(8).toString('hex');
    const hash = crypto.createHash('sha256').update(
        crypto.createHash('sha256').update(password).digest('hex') + salt
    ).digest('hex');
    return `$SHA$${salt}$${hash}`;
}

// Khởi tạo file dữ liệu nếu chưa có
if (!fs.existsSync(DATABASE_FILE)) fs.writeFileSync(DATABASE_FILE, JSON.stringify([]));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
if (!fs.existsSync(RECHARGE_TX_FILE)) fs.writeFileSync(RECHARGE_TX_FILE, JSON.stringify({}));

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
    try {
        const [rows] = await pool.execute('SELECT id FROM authme WHERE username = ?', [username]);
        if (rows.length > 0) {
            return res.status(400).json({ message: 'Tên tài khoản đã tồn tại trên Server' });
        }
        
        const hashedPassword = hashAuthMePassword(password);
        const ip = req.ip || '127.0.0.1';
        
        await pool.execute(
            'INSERT INTO authme (username, realname, password, ip, regdate, regip) VALUES (?, ?, ?, ?, ?, ?)',
            [username.toLowerCase(), username, hashedPassword, ip, Date.now(), ip]
        );
        
        res.json({ status: 'success', message: 'Đăng ký thành công! Bạn có thể dùng tài khoản này vào Server.' });
    } catch (err) {
        console.error('Register Error:', err);
        res.status(500).json({ message: 'Lỗi hệ thống database' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT password, username FROM authme WHERE username = ?', [username]);
        if (rows.length === 0) {
            return res.status(400).json({ message: 'Tài khoản không tồn tại trên Server' });
        }
        
        const user = rows[0];
        if (!verifyAuthMePassword(password, user.password)) {
            return res.status(400).json({ message: 'Sai mật khẩu' });
        }
        
        const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ status: 'success', token, username: user.username });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ message: 'Lỗi hệ thống database' });
    }
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

// Helpers for card-recharge transactions. Keep transaction records separate from display history.
function readRechargeTransactions() {
    return JSON.parse(fs.readFileSync(RECHARGE_TX_FILE, 'utf8'));
}
function writeRechargeTransactions(data) {
    fs.writeFileSync(RECHARGE_TX_FILE, JSON.stringify(data, null, 2));
}
function safeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]{32}$/i.test(a) || !/^[a-f0-9]{32}$/i.test(b)) return false;
    const aa = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function validMinecraftUsername(username) {
    return typeof username === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(username);
}
function positiveInteger(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

app.post('/api/card-recharge', async (req, res) => {
    const { user, type, amount, code, seri } = req.body || {};
    const partnerId = process.env.THECAOSIEUTOC_PARTNER_ID;
    const partnerKey = process.env.THECAOSIEUTOC_PARTNER_KEY;
    const telco = typeof type === 'string' ? type.trim().toUpperCase() : '';
    const denomination = positiveInteger(amount);

    if (!partnerId || !partnerKey) return res.status(503).json({ status: 'error', message: 'Hệ thống nạp thẻ chưa được cấu hình.' });
    if (!validMinecraftUsername(user) || !telco || typeof code !== 'string' || typeof seri !== 'string' || !code.trim() || !seri.trim() || !denomination) {
        return res.status(400).json({ status: 'error', message: 'Thông tin thẻ hoặc tên người chơi không hợp lệ.' });
    }

    const requestId = `nmtcyt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const sign = crypto.createHash('md5').update(partnerKey + code.trim() + seri.trim()).digest('hex');
    const txs = readRechargeTransactions();
    txs[requestId] = {
        request_id: requestId,
        username: user,
        telco,
        requested_value: denomination,
        status: 'submitting',
        created_at: new Date().toISOString()
    };
    writeRechargeTransactions(txs);

    try {
        const response = await axios.post('https://thecaosieutoc.vn/chargingws/v2', {
            command: 'charging',
            partner_id: partnerId,
            sign,
            telco,
            code: code.trim(),
            serial: seri.trim(),
            amount: denomination,
            request_id: requestId
        }, { timeout: 20000 });
        const data = response.data || {};
        const updated = readRechargeTransactions();
        if (updated[requestId]) {
            updated[requestId].provider_response_status = data.status ?? null;
            updated[requestId].submitted_at = new Date().toISOString();
            updated[requestId].status = ['99', 99, 'pending', 'success', '00'].includes(data.status) ? 'pending' : 'rejected';
            writeRechargeTransactions(updated);
        }
        if (['99', 99, 'pending', 'success', '00'].includes(data.status)) {
            return res.json({ status: 'success', message: 'Đã gửi thẻ, đang chờ nhà cung cấp xử lý.', request_id: requestId });
        }
        return res.status(400).json({ status: 'error', message: data.message || data.msg || 'Nhà cung cấp chưa chấp nhận thẻ.' });
    } catch (error) {
        console.error('TheCaoSieuToc submit error:', error.response?.status || error.message);
        const updated = readRechargeTransactions();
        if (updated[requestId]) { updated[requestId].status = 'submission_unknown'; writeRechargeTransactions(updated); }
        return res.status(502).json({ status: 'error', message: 'Chưa xác nhận được trạng thái gửi thẻ. Không gửi lại thẻ này; hãy kiểm tra giao dịch trước.' });
    }
});

// Provider callback configured as POST. Never grant points based only on callback-provided username/amount.
app.post('/api/callback', async (req, res) => {
    const partnerKey = process.env.THECAOSIEUTOC_PARTNER_KEY;
    if (!partnerKey) return res.status(503).send('Callback not configured');

    const payload = req.body || {};
    const { status, request_id, code, serial, callback_sign } = payload;
    if (typeof request_id !== 'string' || typeof code !== 'string' || typeof serial !== 'string' || typeof callback_sign !== 'string') {
        return res.status(400).send('Invalid callback');
    }
    const expectedSign = crypto.createHash('md5').update(partnerKey + code + serial).digest('hex');
    if (!safeEqualHex(callback_sign, expectedSign)) return res.status(403).send('Invalid signature');

    const txs = readRechargeTransactions();
    const tx = txs[request_id];
    if (!tx) return res.status(404).send('Unknown transaction');
    if (tx.status === 'credited' || tx.status === 'processing') return res.status(200).send('OK');

    // Per provider docs, status 1 means successful; other statuses must never grant points.
    if (!(status === 1 || status === '1')) {
        tx.status = 'failed';
        tx.provider_status = String(status);
        tx.updated_at = new Date().toISOString();
        txs[request_id] = tx;
        writeRechargeTransactions(txs);
        return res.status(200).send('OK');
    }

    // Credit using verified face value (value) when provided; fallback is not allowed.
    const faceValue = positiveInteger(payload.value);
    if (!faceValue || faceValue !== Number(tx.requested_value)) {
        tx.status = 'manual_review';
        tx.callback_value = payload.value ?? null;
        tx.updated_at = new Date().toISOString();
        txs[request_id] = tx;
        writeRechargeTransactions(txs);
        console.error('Recharge callback requires review:', request_id);
        return res.status(200).send('OK');
    }

    tx.status = 'processing';
    tx.callback_value = faceValue;
    tx.updated_at = new Date().toISOString();
    txs[request_id] = tx;
    writeRechargeTransactions(txs);

    try {
        // Keep prior behavior: 1 point per VND of the verified face value.
        await executeMcCommand(`points give ${tx.username} ${faceValue}`);
        saveRechargeLocal(tx.username, faceValue);
        await executeMcCommand(`broadcast §6§l[ ★ NẠP THẺ ★ ] §fNgười chơi §b${tx.username} §fvừa nạp thành công §a${faceValue.toLocaleString('vi-VN')}đ §fvào hệ thống!`);
        await executeMcCommand(`title ${tx.username} title {"text":"§a§lTHANKS FOR DONATING!"}`);
        await executeMcCommand(`title ${tx.username} subtitle {"text":"§fBạn đã nhận được §e${faceValue.toLocaleString('vi-VN')} points"}`);
        const latest = readRechargeTransactions();
        if (latest[request_id]) {
            latest[request_id].status = 'credited';
            latest[request_id].credited_at = new Date().toISOString();
            writeRechargeTransactions(latest);
        }
        return res.status(200).send('OK');
    } catch (err) {
        console.error('Callback processing error:', err.message);
        // Leave processing state for manual review to prevent duplicate credits.
        return res.status(500).send('Processing error; manual review required');
    }
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
