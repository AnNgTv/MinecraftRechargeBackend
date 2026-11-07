'use strict';

const crypto = require('crypto');

const AMOUNTS = [10000, 20000, 50000, 100000, 200000, 500000, 1000000];
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function timingSafeTextEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function paymentConfig() {
  const rate = Number.parseInt(process.env.POINTS_PER_1000_VND || '10', 10);
  const eventBonus = Number.parseInt(process.env.PAYMENT_EVENT_BONUS_PERCENT || '0', 10);
  const bankReady = Boolean(
    process.env.BANK_BIN &&
    process.env.BANK_ACCOUNT &&
    process.env.BANK_ACCOUNT_NAME &&
    process.env.SEPAY_WEBHOOK_SECRET &&
    process.env.SEPAY_ACCOUNT_NUMBER
  );
  return {
    enabled: bankReady && Number.isSafeInteger(rate) && rate > 0 &&
      Number.isSafeInteger(eventBonus) && eventBonus >= 0 && eventBonus <= 200,
    bankReady,
    rate,
    eventBonus: Number.isSafeInteger(eventBonus) && eventBonus >= 0 && eventBonus <= 200 ? eventBonus : 0,
    donationBonus: 5
  };
}

async function ensurePaymentSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS nightmare_payment_orders (
    id CHAR(36) PRIMARY KEY,
    payment_code VARCHAR(24) NOT NULL UNIQUE,
    username VARCHAR(16) NOT NULL,
    transaction_type ENUM('recharge','donation') NOT NULL,
    amount_vnd BIGINT UNSIGNED NOT NULL,
    base_points BIGINT UNSIGNED NOT NULL,
    bonus_percent INT UNSIGNED NOT NULL DEFAULT 0,
    bonus_points BIGINT UNSIGNED NOT NULL DEFAULT 0,
    total_points BIGINT UNSIGNED NOT NULL,
    status ENUM('pending','paid','fulfilled','needs_review','expired') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    paid_at TIMESTAMP NULL,
    fulfilled_at TIMESTAMP NULL,
    INDEX idx_nightmare_payment_user (username, created_at),
    INDEX idx_nightmare_payment_status (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS nightmare_payment_events (
    transaction_id VARCHAR(100) PRIMARY KEY,
    order_id CHAR(36) NULL,
    amount_vnd BIGINT UNSIGNED NOT NULL,
    transfer_type VARCHAR(16) NULL,
    account_number VARCHAR(64) NULL,
    status VARCHAR(32) NOT NULL,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_nightmare_payment_event_order (order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

function validSePayWebhook(req) {
  const secret = process.env.SEPAY_WEBHOOK_SECRET || '';
  const timestamp = req.get('X-SePay-Timestamp') || '';
  const signature = req.get('X-SePay-Signature') || '';
  if (!secret || !Buffer.isBuffer(req.rawBody) || !/^\\d{10}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(timestamp + '.').update(req.rawBody).digest('hex');
  return timingSafeTextEqual(signature.toLowerCase(), expected.toLowerCase());
}

function extractPaymentCode(payload) {
  const text = [payload.code, payload.content, payload.description].filter(Boolean).join(' ').toUpperCase();
  return (text.match(/\\bNTCYT[0-9A-F]{12}\\b/) || [])[0] || null;
}

function registerPayments(app, pool, authenticateToken, executeMcCommand) {
  app.get('/api/payments/config', (req, res) => {
    const cfg = paymentConfig();
    res.json({
      status: 'success',
      enabled: cfg.enabled,
      rate: cfg.rate,
      donationBonus: cfg.donationBonus,
      eventBonus: cfg.eventBonus,
      amounts: AMOUNTS
    });
  });

  app.post('/api/payments/orders', authenticateToken, async (req, res) => {
    const username = String(req.user?.username || '');
    const amount = Number(req.body?.amount);
    const type = String(req.body?.type || '').toLowerCase();
    const cfg = paymentConfig();
    if (!cfg.enabled) return res.status(503).json({ status: 'error', message: 'Thanh toán ngân hàng chưa được cấu hình đầy đủ.' });
    if (!USERNAME_RE.test(username) || !AMOUNTS.includes(amount) || !['recharge', 'donation'].includes(type)) {
      return res.status(400).json({ status: 'error', message: 'Loại giao dịch, số tiền hoặc tài khoản không hợp lệ.' });
    }

    const basePoints = Math.floor((amount / 1000) * cfg.rate);
    const bonusPercent = cfg.eventBonus + (type === 'donation' ? cfg.donationBonus : 0);
    const bonusPoints = Math.floor(basePoints * bonusPercent / 100);
    const totalPoints = basePoints + bonusPoints;
    const id = crypto.randomUUID();
    const paymentCode = 'NTCYT' + crypto.randomBytes(6).toString('hex').toUpperCase();
    try {
      await pool.execute(`INSERT INTO nightmare_payment_orders
        (id,payment_code,username,transaction_type,amount_vnd,base_points,bonus_percent,bonus_points,total_points,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,DATE_ADD(NOW(), INTERVAL 30 MINUTE))`,
        [id, paymentCode, username, type, amount, basePoints, bonusPercent, bonusPoints, totalPoints]);

      const qr = new URL(`https://img.vietqr.io/image/${encodeURIComponent(process.env.BANK_BIN)}-${encodeURIComponent(process.env.BANK_ACCOUNT)}-compact2.png`);
      qr.searchParams.set('amount', String(amount));
      qr.searchParams.set('addInfo', paymentCode);
      qr.searchParams.set('accountName', process.env.BANK_ACCOUNT_NAME);
      return res.status(201).json({
        status: 'success',
        order: {
          id, paymentCode, type, amount, basePoints, bonusPercent, bonusPoints, totalPoints,
          expiresInMinutes: 30,
          transferContent: paymentCode,
          qrUrl: qr.toString(),
          bank: { bin: process.env.BANK_BIN, account: process.env.BANK_ACCOUNT, accountName: process.env.BANK_ACCOUNT_NAME },
          status: 'pending'
        }
      });
    } catch (err) {
      console.error('Payment order create failed:', err.code || 'DB_ERROR');
      return res.status(503).json({ status: 'error', message: 'Không tạo được đơn thanh toán. Vui lòng thử lại.' });
    }
  });

  app.get('/api/payments/orders/:id', authenticateToken, async (req, res) => {
    try {
      await pool.execute("UPDATE nightmare_payment_orders SET status='expired' WHERE id=? AND LOWER(username)=LOWER(?) AND status='pending' AND expires_at<=NOW()", [req.params.id, req.user.username]);
      const [rows] = await pool.execute(`SELECT o.id,o.payment_code,o.transaction_type,o.amount_vnd,o.base_points,
        o.bonus_percent,o.bonus_points,o.total_points,o.status,o.created_at,o.expires_at,o.paid_at,o.fulfilled_at,
        c.status AS command_status,c.result_message
        FROM nightmare_payment_orders o
        LEFT JOIN nightmare_game_commands c ON c.id=o.id
        WHERE o.id=? AND LOWER(o.username)=LOWER(?) LIMIT 1`, [req.params.id, req.user.username]);
      if (!rows.length) return res.status(404).json({ status: 'error', message: 'Không tìm thấy đơn thanh toán.' });
      const o = rows[0];
      let status = o.status;
      if (o.command_status === 'completed') status = 'fulfilled';
      else if (o.command_status === 'failed') status = 'needs_review';
      return res.json({ status: 'success', order: {
        id: o.id, paymentCode: o.payment_code, type: o.transaction_type,
        amount: Number(o.amount_vnd), basePoints: Number(o.base_points),
        bonusPercent: Number(o.bonus_percent), bonusPoints: Number(o.bonus_points),
        totalPoints: Number(o.total_points), status,
        message: o.result_message || null, createdAt: o.created_at,
        expiresAt: o.expires_at, paidAt: o.paid_at, fulfilledAt: o.fulfilled_at
      }});
    } catch (err) {
      console.error('Payment order status failed:', err.code || 'DB_ERROR');
      return res.status(503).json({ status: 'error', message: 'Không đọc được trạng thái đơn.' });
    }
  });

  app.post('/webhooks/sepay', async (req, res) => {
    if (!validSePayWebhook(req)) return res.status(401).json({ status: 'error', message: 'Invalid webhook signature.' });
    let payload;
    try { payload = JSON.parse(req.rawBody.toString('utf8')); }
    catch { return res.status(400).json({ status: 'error', message: 'Invalid JSON.' }); }

    const transactionId = String(payload.id ?? '');
    const amount = Number(payload.transferAmount);
    const transferType = String(payload.transferType || '').toLowerCase();
    const accountNumber = String(payload.accountNumber || '');
    const expectedAccount = String(process.env.SEPAY_ACCOUNT_NUMBER || '');
    const paymentCode = extractPaymentCode(payload);
    if (!transactionId || transactionId.length > 100 || !Number.isSafeInteger(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid transaction.' });
    }

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const [eventResult] = await conn.execute(`INSERT IGNORE INTO nightmare_payment_events
        (transaction_id,amount_vnd,transfer_type,account_number,status) VALUES (?,?,?,?, 'received')`,
        [transactionId, amount, transferType, accountNumber || null]);
      if (!eventResult.affectedRows) {
        await conn.commit();
        return res.status(200).json({ status: 'success', duplicate: true });
      }

      if (transferType !== 'in' || !expectedAccount || accountNumber !== expectedAccount || !paymentCode) {
        await conn.execute("UPDATE nightmare_payment_events SET status='ignored' WHERE transaction_id=?", [transactionId]);
        await conn.commit();
        return res.status(200).json({ status: 'success', matched: false });
      }

      const [orders] = await conn.execute(`SELECT id,username,amount_vnd,total_points,status,(expires_at > NOW()) AS not_expired
        FROM nightmare_payment_orders WHERE payment_code=? FOR UPDATE`, [paymentCode]);
      if (!orders.length) {
        await conn.execute("UPDATE nightmare_payment_events SET status='unmatched' WHERE transaction_id=?", [transactionId]);
        await conn.commit();
        return res.status(200).json({ status: 'success', matched: false });
      }
      const order = orders[0];
      if (Number(order.amount_vnd) !== amount) {
        await conn.execute("UPDATE nightmare_payment_events SET status='amount_mismatch',order_id=? WHERE transaction_id=?", [order.id, transactionId]);
        await conn.commit();
        return res.status(200).json({ status: 'success', matched: false, reason: 'amount_mismatch' });
      }
      if (order.status !== 'pending' || Number(order.not_expired) !== 1) {
        if (order.status === 'pending') await conn.execute("UPDATE nightmare_payment_orders SET status='expired' WHERE id=? AND status='pending'", [order.id]);
        await conn.execute("UPDATE nightmare_payment_events SET status='order_not_pending',order_id=? WHERE transaction_id=?", [order.id, transactionId]);
        await conn.commit();
        return res.status(200).json({ status: 'success', matched: false });
      }

      const [paid] = await conn.execute(`UPDATE nightmare_payment_orders SET status='paid',paid_at=NOW()
        WHERE id=? AND status='pending' AND amount_vnd=?`, [order.id, amount]);
      if (paid.affectedRows) {
        // Reuse the existing plugin approval/claim/complete queue; no direct RCON retry risk.
        await conn.execute(`INSERT INTO nightmare_game_commands
          (id,username,command_type,amount,status,result_message)
          VALUES (?,?,'points',?,'approved','Thanh toán SePay đã xác minh.')`,
          [order.id, order.username, Number(order.total_points)]);
        await conn.execute("UPDATE nightmare_payment_events SET status='paid',order_id=? WHERE transaction_id=?", [order.id, transactionId]);
      }
      await conn.commit();
      return res.status(200).json({ status: 'success', matched: Boolean(paid.affectedRows) });
    } catch (err) {
      if (conn) await conn.rollback();
      console.error('SePay webhook processing failed:', err.code || 'DB_ERROR');
      return res.status(500).json({ status: 'error', message: 'Webhook processing failed.' });
    } finally {
      if (conn) conn.release();
    }
  });

  return ensurePaymentSchema(pool);
}

module.exports = { registerPayments, ensurePaymentSchema };
