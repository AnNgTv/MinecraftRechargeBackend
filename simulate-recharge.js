const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { Rcon } = require('rcon-client');

const DATABASE_FILE = path.join(__dirname, 'recharges.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

function saveRecharge(username, amount) {
    // 1. Cập nhật Tổng nạp (Top)
    const data = JSON.parse(fs.readFileSync(DATABASE_FILE));
    const userIndex = data.findIndex(item => item.username === username);
    if (userIndex !== -1) {
        data[userIndex].total += parseInt(amount);
    } else {
        data.push({ username, total: parseInt(amount), lastUpdate: new Date() });
    }
    data.sort((a, b) => b.total - a.total);
    fs.writeFileSync(DATABASE_FILE, JSON.stringify(data, null, 2));

    // 2. Lưu vào Lịch sử nạp (Gần đây)
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE));
    history.unshift({ username, amount: parseInt(amount), date: new Date() });
    if (history.length > 20) history.pop();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

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
    }
}

async function runSimulation() {
    const user = 'DuongLegend2';
    const amount = 5000000000;
    
    console.log(`Simulating recharge for ${user}: ${amount.toLocaleString()}đ`);
    
    saveRecharge(user, amount);
    console.log('✅ Database updated.');

    await executeMcCommand(`eco give ${user} ${amount}`);
    await executeMcCommand(`bc §6§l[ ★ NẠP THẺ ★ ] §fNgười chơi §b${user} §fvừa nạp thành công §a${amount.toLocaleString()}đ §fvào hệ thống!`);
    await executeMcCommand(`title ${user} title {"text":"§a§lTHANKS FOR DONATING!"}`);
    await executeMcCommand(`title ${user} subtitle {"text":"§fBạn đã nhận được §e${amount.toLocaleString()} xu"}`);
    console.log('✅ Minecraft commands executed.');
    
    process.exit(0);
}

runSimulation();
