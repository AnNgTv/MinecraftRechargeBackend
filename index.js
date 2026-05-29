require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Rcon } = require('rcon-client');
const axios = require('axios');
const cors = require('cors');

const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DATABASE_FILE = path.join(__dirname, 'recharges.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Khởi tạo file dữ liệu nếu chưa có
if (!fs.existsSync(DATABASE_FILE)) fs.writeFileSync(DATABASE_FILE, JSON.stringify([]));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

// Hàm lưu lịch sử nạp (Local JSON)
function saveRechargeLocal(username, amount) {
    const data = JSON.parse(fs.readFileSync(DATABASE_FILE));
    const userIndex = data.findIndex(item => item.username === username);
    if (userIndex !== -1) {
        data[userIndex].total += parseInt(amount);
    } else {
        data.push({ username, total: parseInt(amount), lastUpdate: new Date() });
    }
    data.sort((a, b) => b.total - a.total);
    fs.writeFileSync(DATABASE_FILE, JSON.stringify(data, null, 2));

    const history = JSON.parse(fs.readFileSync(HISTORY_FILE));
    history.unshift({ username, amount: parseInt(amount), date: new Date() });
    if (history.length > 20) history.pop();
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
        console.log('RCON Connected!');
        const response = await rcon.send(command);
        console.log('RCON Response:', response);
        await rcon.end();
        return response;
    } catch (err) {
        console.error('RCON Error:', err);
        throw err;
    }
}

// 1. Endpoint nhận thẻ từ Website
app.post('/api/card-recharge', async (req, res) => {
    const { user, type, amount, code, seri } = req.body;
    console.log(`Received recharge request for user: ${user} | Card: ${type} | Amount: ${amount}`);

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
        console.error('API Error:', error.message);
        res.status(500).json({ status: 'error', message: 'Lỗi kết nối gạch thẻ.' });
    }
});

// 2. Endpoint CALLBACK
app.post('/api/callback', async (req, res) => {
    if (req.query.token !== process.env.CALLBACK_TOKEN) {
        return res.status(403).send('Sai mã bảo mật');
    }

    const { status, request_id, amount } = req.body;
    const username = request_id.split('_')[0];

    if (status === 'success' || status === '1') {
        try {
            saveRechargeLocal(username, amount);
            const gameAmount = parseInt(amount);

            // Gửi lệnh qua RCON
            await executeMcCommand(`eco give ${username} ${gameAmount}`);
            await executeMcCommand(`bc §6§l[ ★ NẠP THẺ ★ ] §fNgười chơi §b${username} §fvừa nạp thành công §a${amount.toLocaleString()}đ §fvào hệ thống!`);
            await executeMcCommand(`title ${username} title {"text":"§a§lTHANKS FOR DONATING!"}`);
            await executeMcCommand(`title ${username} subtitle {"text":"§fBạn đã nhận được §e${gameAmount.toLocaleString()} xu"}`);
            
            console.log(`Successfully executed RCON commands for ${username}`);
        } catch (err) {
            console.error('Callback Processing Error:', err);
        }
    }
    res.send('OK');
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
    console.log(`Backend server with RCON running on port ${PORT}`);
});
