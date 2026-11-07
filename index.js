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
app.use(bodyParser.json({ verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
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
const PLUGIN_SHARED_KEY = process.env.PLUGIN_SHARED_KEY || '';
const ADMIN_SHARED_KEY = process.env.ADMIN_SHARED_KEY || '';
const DISCORD_BOT_SHARED_KEY = process.env.DISCORD_BOT_SHARED_KEY || '';

async function ensureSyncSchema() {
    await pool.query(`CREATE TABLE IF NOT EXISTS nightmare_player_sync (
        minecraft_uuid VARCHAR(36) PRIMARY KEY,
        username VARCHAR(16) NOT NULL,
        rank_name VARCHAR(64) NOT NULL,
        points BIGINT UNSIGNED NOT NULL DEFAULT 0,
        balance DECIMAL(20,2) NOT NULL DEFAULT 0,
        synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_nightmare_sync_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query(`CREATE TABLE IF NOT EXISTS nightmare_game_commands (
        id CHAR(36) PRIMARY KEY,
        username VARCHAR(16) NOT NULL,
        command_type ENUM('points','money') NOT NULL,
        amount BIGINT UNSIGNED NOT NULL,
        status ENUM('pending','approved','rejected','processing','completed','failed') NOT NULL DEFAULT 'pending',
        result_message VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        claimed_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        reviewed_by VARCHAR(64) NULL,
        reviewed_at TIMESTAMP NULL,
        INDEX idx_nightmare_commands_user (username, created_at),
        INDEX idx_nightmare_commands_status (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    // Upgrade databases created by earlier plugin/backend builds.
    await pool.query("ALTER TABLE nightmare_game_commands MODIFY status ENUM('pending','approved','rejected','processing','completed','failed') NOT NULL DEFAULT 'pending'");
    for (const column of [
        ['reviewed_by', 'VARCHAR(64) NULL'],
        ['reviewed_at', 'TIMESTAMP NULL']
    ]) {
        try { await pool.query(`ALTER TABLE nightmare_game_commands ADD COLUMN ${column[0]} ${column[1]}`); }
        catch (err) { if (err.code !== 'ER_DUP_FIELDNAME') throw err; }
    }
}

function requirePluginKey(req, res, next) {
    const supplied = req.get('X-Plugin-Key') || '';
    if (!PLUGIN_SHARED_KEY || supplied.length !== PLUGIN_SHARED_KEY.length ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(PLUGIN_SHARED_KEY))) {
        return res.status(403).json({ status: 'error', message: 'Plugin authentication failed' });
    }
    next();
}

function requireAdminKey(req, res, next) {
    const supplied = req.get('X-Admin-Key') || '';
    if (!ADMIN_SHARED_KEY || supplied.length !== ADMIN_SHARED_KEY.length ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(ADMIN_SHARED_KEY))) {
        return res.status(403).json({ status: 'error', message: 'Admin approval authentication failed' });
    }
    next();
}

function requireDiscordKey(req, res, next) {
    const supplied = req.get('X-Discord-Key') || '';
    if (!DISCORD_BOT_SHARED_KEY || supplied.length !== DISCORD_BOT_SHARED_KEY.length ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(DISCORD_BOT_SHARED_KEY))) {
        return res.status(403).json({ status: 'error', message: 'Discord bot authentication failed' });
    }
    next();
}

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

// Minecraft plugin -> backend: authoritative snapshot from LuckPerms, PlayerPoints and Vault.
app.post('/internal/sync/player', requirePluginKey, async (req, res) => {
    const { uuid, username, rank, points, balance } = req.body || {};
    if (!/^[0-9a-f-]{36}$/i.test(String(uuid || '')) || !validMinecraftUsername(username) ||
        typeof rank !== 'string' || rank.length < 1 || rank.length > 64 ||
        !Number.isSafeInteger(Number(points)) || Number(points) < 0 ||
        !Number.isFinite(Number(balance)) || Number(balance) < 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid player snapshot' });
    }
    try {
        await ensureSyncSchema();
        await pool.execute(`INSERT INTO nightmare_player_sync
            (minecraft_uuid, username, rank_name, points, balance)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE username=VALUES(username), rank_name=VALUES(rank_name),
            points=VALUES(points), balance=VALUES(balance), synced_at=CURRENT_TIMESTAMP`,
            [String(uuid).toLowerCase(), username, rank, String(points), String(balance)]);
        return res.json({ status: 'success', synced: true });
    } catch (err) {
        console.error('Minecraft sync failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Sync storage unavailable' });
    }
});

// Website -> Minecraft: create a durable, owner-bound credit request.
app.post('/api/game/credits', authenticateToken, async (req, res) => {
    const username = req.user.username;
    const type = String(req.body?.type || '').toLowerCase();
    const amount = positiveInteger(req.body?.amount);
    if (!['points', 'money'].includes(type) || !amount || amount > 1000000) {
        return res.status(400).json({ status: 'error', message: 'Loại giao dịch hoặc số lượng không hợp lệ (tối đa 1.000.000).' });
    }
    try {
        const [recent] = await pool.execute(
            "SELECT COUNT(*) AS total FROM nightmare_game_commands WHERE LOWER(username)=LOWER(?) AND created_at >= NOW() - INTERVAL 1 HOUR",
            [username]
        );
        if (Number(recent[0].total) >= 5) return res.status(429).json({ status: 'error', message: 'Bạn đã đạt giới hạn 5 yêu cầu mỗi giờ.' });
        const id = crypto.randomUUID();
        await pool.execute(
            "INSERT INTO nightmare_game_commands (id, username, command_type, amount) VALUES (?, ?, ?, ?)",
            [id, username, type, amount]
        );
        return res.status(201).json({ status: 'success', request: { id, username, type, amount, status: 'pending' } });
    } catch (err) {
        console.error('Game credit request failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Không tạo được yêu cầu. Vui lòng thử lại sau.' });
    }
});

app.get('/api/game/credits/:id', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id, username, command_type AS type, amount, status, result_message AS message, created_at AS createdAt, completed_at AS completedAt FROM nightmare_game_commands WHERE id=? AND LOWER(username)=LOWER(?) LIMIT 1',
            [req.params.id, req.user.username]
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'Không tìm thấy yêu cầu.' });
        return res.json({ status: 'success', request: rows[0] });
    } catch (err) {
        return res.status(503).json({ status: 'error', message: 'Không đọc được trạng thái yêu cầu.' });
    }
});

// Plugin polls pending website requests so online administrators can be notified.
app.get('/internal/commands/pending', requirePluginKey, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            "SELECT id, username, command_type AS type, amount, created_at AS createdAt FROM nightmare_game_commands WHERE status='pending' ORDER BY created_at ASC LIMIT 30"
        );
        return res.json({ status: 'success', requests: rows });
    } catch (err) {
        console.error('Pending game command poll failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Pending request queue unavailable' });
    }
});

// Only an administrator can approve a request after independently verifying payment/authorization.
app.post('/internal/commands/:id/approve', requireAdminKey, async (req, res) => {
    try {
        const [result] = await pool.execute("UPDATE nightmare_game_commands SET status='approved', result_message='Đã được quản trị viên duyệt.' WHERE id=? AND status='pending'", [req.params.id]);
        if (!result.affectedRows) return res.status(409).json({ status: 'error', message: 'Yêu cầu không tồn tại hoặc không còn ở trạng thái chờ duyệt.' });
        return res.json({ status: 'success', approved: true });
    } catch (err) {
        console.error('Game command approval failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Không thể duyệt yêu cầu.' });
    }
});

// Discord bot: fetch pending requests and record an auditable approve/reject decision.
app.get('/internal/discord/credits/pending', requireDiscordKey, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            "SELECT id, username, command_type AS type, amount, created_at AS createdAt FROM nightmare_game_commands WHERE status='pending' ORDER BY created_at ASC LIMIT 50"
        );
        return res.json({ status: 'success', requests: rows });
    } catch (err) {
        console.error('Discord credit queue failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Credit review queue unavailable' });
    }
});

app.post('/internal/discord/credits/:id/decision', requireDiscordKey, async (req, res) => {
    const decision = String(req.body?.decision || '').toLowerCase();
    const moderatorId = String(req.body?.moderatorId || '').trim();
    if (!['approve', 'reject'].includes(decision) || !/^\d{17,20}$/.test(moderatorId)) {
        return res.status(400).json({ status: 'error', message: 'Invalid decision or moderator ID.' });
    }
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const message = decision === 'approve' ? 'Đã được duyệt qua Discord.' : 'Đã bị từ chối qua Discord.';
    try {
        const [result] = await pool.execute(
            "UPDATE nightmare_game_commands SET status=?, result_message=?, reviewed_by=?, reviewed_at=NOW() WHERE id=? AND status='pending'",
            [status, message, moderatorId, req.params.id]
        );
        if (!result.affectedRows) return res.status(409).json({ status: 'error', message: 'Yêu cầu không tồn tại hoặc đã được xử lý.' });
        return res.json({ status: 'success', decision: status, reviewedBy: moderatorId });
    } catch (err) {
        console.error('Discord credit decision failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Could not save the decision.' });
    }
});

// A claimed request is never auto-replayed after a crash, preventing duplicate credits.
app.post('/internal/commands/claim', requirePluginKey, async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const [rows] = await conn.query("SELECT id, username, command_type AS type, amount FROM nightmare_game_commands WHERE status='approved' ORDER BY created_at ASC LIMIT 1 FOR UPDATE");
        if (!rows.length) { await conn.commit(); return res.json({ status: 'success', command: null }); }
        const command = rows[0];
        await conn.execute("UPDATE nightmare_game_commands SET status='processing', claimed_at=NOW() WHERE id=? AND status='approved'", [command.id]);
        await conn.commit();
        return res.json({ status: 'success', command });
    } catch (err) {
        if (conn) await conn.rollback();
        console.error('Game command claim failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Command queue unavailable' });
    } finally { if (conn) conn.release(); }
});

app.post('/internal/commands/:id/complete', requirePluginKey, async (req, res) => {
    const success = req.body?.success === true;
    const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 240) : '';
    try {
        const [result] = await pool.execute(
            "UPDATE nightmare_game_commands SET status=?, result_message=?, completed_at=NOW() WHERE id=? AND status='processing'",
            [success ? 'completed' : 'failed', message || (success ? 'Đã cộng thành công.' : 'Server từ chối giao dịch.'), req.params.id]
        );
        if (!result.affectedRows) return res.status(409).json({ status: 'error', message: 'Request is not processing or was already finalized.' });
        return res.json({ status: 'success', finalized: true });
    } catch (err) {
        console.error('Game command completion failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Could not finalize command' });
    }
});

// --- API AUTH ---

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body || {};
    if (!validMinecraftUsername(username) || typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return res.status(400).json({ message: 'Tên tài khoản hoặc mật khẩu không hợp lệ (mật khẩu tối thiểu 8 ký tự).' });
    }
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
    const { username, password } = req.body || {};
    if (!validMinecraftUsername(username) || typeof password !== 'string' || password.length < 1 || password.length > 128) {
        return res.status(400).json({ message: 'Thông tin đăng nhập không hợp lệ.' });
    }
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
        await ensureSyncSchema();
        const [rows] = await pool.execute(
            'SELECT username, rank_name, points, balance, synced_at FROM nightmare_player_sync WHERE LOWER(username)=LOWER(?) ORDER BY synced_at DESC LIMIT 1',
            [username]
        );
        const data = JSON.parse(fs.readFileSync(DATABASE_FILE, 'utf8'));
        const recharge = data.find(item => item.username.toLowerCase() === username.toLowerCase());
        const snapshot = rows[0];
        return res.json({ status: 'success', user: {
            username,
            rank: snapshot ? snapshot.rank_name : null,
            points: snapshot ? String(snapshot.points) : null,
            balance: snapshot ? Number(snapshot.balance) : null,
            syncedAt: snapshot ? snapshot.synced_at : null,
            totalRecharge: recharge ? recharge.total : 0,
            gameConnected: Boolean(snapshot)
        }});
    } catch (err) {
        console.error('Profile sync read failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Không đọc được dữ liệu máy chủ game.' });
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

app.post('/api/card-recharge', authenticateToken, async (req, res) => {
    const { user, type, amount, code, seri } = req.body || {};
    if (typeof user !== 'string' || user.toLowerCase() !== String(req.user.username).toLowerCase()) {
        return res.status(403).json({ status: 'error', message: 'Bạn chỉ có thể nạp cho tài khoản đang đăng nhập.' });
    }
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
    if (!validMinecraftUsername(username)) return res.status(400).json({ status: 'error', message: 'Tên người chơi không hợp lệ.' });
    try {
        await ensureSyncSchema();
        const [rows] = await pool.execute(
            'SELECT username, rank_name, points, balance, synced_at FROM nightmare_player_sync WHERE LOWER(username)=LOWER(?) ORDER BY synced_at DESC LIMIT 1',
            [username]
        );
        const data = JSON.parse(fs.readFileSync(DATABASE_FILE, 'utf8'));
        const recharge = data.find(item => item.username.toLowerCase() === username.toLowerCase());
        const snapshot = rows[0];
        return res.json({ status: 'success', data: {
            username, rank: snapshot?.rank_name ?? null,
            points: snapshot ? String(snapshot.points) : null,
            balance: snapshot ? Number(snapshot.balance) : null,
            syncedAt: snapshot?.synced_at ?? null,
            gameConnected: Boolean(snapshot), totalRecharge: recharge?.total ?? 0
        }});
    } catch (err) {
        console.error('Player lookup failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Dữ liệu game hiện chưa khả dụng.' });
    }
});

app.get('/api/top-players', async (req, res) => {
    const sort = ['points', 'balance'].includes(String(req.query.sort || '').toLowerCase())
        ? String(req.query.sort).toLowerCase() : 'points';
    try {
        await ensureSyncSchema();
        const [rows] = await pool.query(`SELECT username, rank_name AS rank, points, balance, synced_at AS syncedAt
            FROM nightmare_player_sync ORDER BY ${sort} DESC, synced_at DESC LIMIT 50`);
        return res.json({ status: 'success', players: rows.map(row => ({
            ...row, points: String(row.points), balance: Number(row.balance)
        })) });
    } catch (err) {
        console.error('Leaderboard read failed:', err.code || 'DB_ERROR');
        return res.status(503).json({ status: 'error', message: 'Bảng xếp hạng game chưa khả dụng.' });
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

// Health check: reports database availability without exposing connection details.
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        return res.json({ status: 'ok', database: 'connected' });
    } catch (err) {
        console.error('Database health check failed:', err.code || 'DB_ERROR');
        return res.status(503).json({
            status: 'degraded',
            database: 'unavailable',
            code: err.code || 'DB_ERROR'
        });
    }
});

ensureSyncSchema().then(() => console.log('Minecraft sync schema ready')).catch(err => console.error('Minecraft sync schema unavailable:', err.code || 'DB_ERROR'));
const { registerPayments } = require('./payments');
registerPayments(app, pool, authenticateToken, executeMcCommand)
    .then(() => console.log('Payment order schema ready'))
    .catch(err => console.error('Payment order schema unavailable:', err.code || 'DB_ERROR'));


app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
});
