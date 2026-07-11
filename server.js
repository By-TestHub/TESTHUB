const express = require('express');
const mysql = require('mysql2/promise');
const fetch = require('axios');
const tls = require("tls");
const path = require('path');

tls.DEFAULT_MIN_VERSION = "TLSv1.3";

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // ส่งไฟล์หน้าบ้านออกไปแสดงผล

const OWNER_PHONE = "095XXXXXXX"; // เปลี่ยนเป็นเบอร์ Wallet ของคุณที่ต้องการรับเงิน

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '', // ใส่รหัสผ่าน MySQL ของคุณ
    database: 'testhub_shop',
    waitForConnections: true,
    connectionLimit: 10
});

// ฟังก์ชันดึงเงินจากซอง TrueMoney Wallet
async function redeemVouchers(phone_number, voucher_code) {
    voucher_code = voucher_code.replace('https://gift.truemoney.com/campaign/?v=', '');
    if (!/^[a-z0-9]*$/i.test(voucher_code) || voucher_code.length <= 0) {
        return { status: 'FAIL', reason: 'รูปแบบลิงก์ซองของขวัญไม่ถูกต้อง' };
    }
    
    const data = { mobile: `${phone_number}`, voucher_hash: `${voucher_code}` };
    try {
        const response = await fetch(`https://gift.truemoney.com/campaign/vouchers/${voucher_code}/redeem`, {
            method: 'post',
            data: JSON.stringify(data),
            headers: { 'Content-Type': 'application/json' },
        });
        const resjson = response.data ? response.data : response.response.data;
        
        if (resjson.status.code == 'SUCCESS') {
            return {
                status: 'SUCCESS',
                amount: parseInt(resjson.data.voucher.redeemed_amount_baht)
            };
        } else {
            return { status: 'FAIL', reason: resjson.status.message };
        }
    } catch (err) {
        return { status: 'FAIL', reason: 'ติดต่อเซิร์ฟเวอร์ TrueMoney ไม่ได้' };
    }
}

// หน้าแรกเปิดเว็บ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API 1: สมัครสมาชิก
app.post('/api/auth/register', async (req, res) => {
    const { username, password, confirmPassword } = req.body;
    if (!username || !password || !confirmPassword) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบ' });
    if (password !== confirmPassword) return res.status(400).json({ message: 'รหัสผ่านยืนยันไม่ตรงกัน' });

    try {
        const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
        if (rows.length > 0) return res.status(400).json({ message: 'มีชื่อผู้ใช้งานนี้ในระบบแล้ว' });

        await pool.query('INSERT INTO users (username, password, points) VALUES (?, ?, 0)', [username, password]);
        return res.json({ message: 'สมัครสมาชิกสำเร็จ!' });
    } catch (err) {
        return res.status(500).json({ message: 'เกิดข้อผิดพลาดหลังบ้าน' });
    }
});

// API 2: เข้าสู่ระบบ
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT id, username, points, role FROM users WHERE username = ? AND password = ?', [username, password]);
        if (rows.length === 0) return res.status(400).json({ message: 'ชื่อผู้ใช้งาน หรือรหัสผ่านไม่ถูกต้อง' });
        return res.json({ message: 'เข้าสู่ระบบสำเร็จ', user: rows[0] });
    } catch (err) {
        return res.status(500).json({ message: 'เกิดข้อผิดพลาดหลังบ้าน' });
    }
});

// API 3: ดึงรายการสินค้าหน้าร้าน
app.get('/api/marketplace/products', async (req, res) => {
    try {
        const [products] = await pool.query('SELECT p.*, COUNT(s.id) as stock_count FROM products p LEFT JOIN stocks s ON p.id = s.product_id AND s.status = "available" GROUP BY p.id');
        return res.json(products);
    } catch (err) {
        return res.status(500).json({ message: 'โหลดข้อมูลล้มเหลว' });
    }
});

// API 4: ระบบซื้อสินค้าสกัดการซื้อซ้อน (Transaction)
app.post('/api/marketplace/buy', async (req, res) => {
    const { userId, productId } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 1. ตรวจแต้มผู้ใช้ + ล็อกแถว
        const [userRows] = await connection.query('SELECT points FROM users WHERE id = ? FOR UPDATE', [userId]);
        if (userRows.length === 0) throw new Error('ไม่พบผู้ใช้');

        // 2. ตรวจราคาสินค้า
        const [productRows] = await connection.query('SELECT name, price FROM products WHERE id = ?', [productId]);
        if (productRows.length === 0) throw new Error('ไม่พบสินค้า');
        const { price, name } = productRows[0];

        if (parseFloat(userRows[0].points) < parseFloat(price)) {
            return res.status(400).json({ message: 'พ้อยท์ของคุณไม่เพียงพอ กรุณาเติมเงินก่อนครับ' });
        }

        // 3. จองไอดีในคลัง + ล็อกแถวป้องกันคนแย่งตัวสุดท้าย
        const [stockRows] = await connection.query('SELECT id, account_data FROM stocks WHERE product_id = ? AND status = "available" LIMIT 1 FOR UPDATE', [productId]);
        if (stockRows.length === 0) {
            return res.status(400).json({ message: 'ขออภัย สินค้าชิ้นนี้เพิ่งหมดไปเมื่อครู่นี้เอง' });
        }
        const { id: stockId, account_data: accountData } = stockRows[0];

        // 4. หักเงิน / อัปเดตสถานะคลัง / บันทึก Log
        await connection.query('UPDATE users SET points = points - ? WHERE id = ?', [price, userId]);
        await connection.query('UPDATE stocks SET status = "sold", sold_to = ?, sold_at = NOW() WHERE id = ?', [userId, stockId]);
        await connection.query('INSERT INTO transactions (user_id, type, amount, description, created_at) VALUES (?, "purchase", ?, ?, NOW())', [userId, price, `ซื้อสินค้า: ${name}`]);

        await connection.commit();
        return res.json({ message: 'ซื้อสินค้าสำเร็จ!', account_data: accountData });
    } catch (err) {
        await connection.rollback();
        return res.status(500).json({ message: err.message || 'ระบบขัดข้อง คืนเงินเรียบร้อย' });
    } finally {
        connection.release();
    }
});

// API 5: เติมเงินผ่านซองของขวัญ
app.post('/api/payment/topup', async (req, res) => {
    const { userId, voucherLink } = req.body;
    if (!userId || !voucherLink) return res.status(400).json({ message: 'ข้อมูลไม่ครบถ้วน' });

    const twResult = await redeemVouchers(OWNER_PHONE, voucherLink);
    if (twResult.status !== 'SUCCESS') return res.status(400).json({ message: twResult.reason });

    const amount = twResult.amount;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        await connection.query('UPDATE users SET points = points + ? WHERE id = ?', [amount, userId]);
        await connection.query('INSERT INTO transactions (user_id, type, amount, description, created_at) VALUES (?, "topup", ?, "เติมเงินผ่านซอง TrueMoney Wallet", NOW())', [userId, amount]);
        await connection.commit();
        return res.json({ message: `เติมเงินสำเร็จ! ได้รับ ฿${amount}.00`, amount });
    } catch (err) {
        await connection.rollback();
        return res.status(500).json({ message: 'เกิดข้อผิดพลาดในการบันทึกพ้อยท์' });
    } finally {
        connection.release();
    }
});

// API 6: ดึงประวัติธุรกรรม
app.get('/api/user/history/:userId', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT type, amount, description, DATE_FORMAT(created_at, "%Y-%m-%d %H:%i") as date FROM transactions WHERE user_id = ? ORDER BY id DESC', [req.params.userId]);
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ message: 'โหลดประวัติล้มเหลว' });
    }
});

app.listen(3000, () => console.log('เซิร์ฟเวอร์ TESTHUB-SHOP เปิดใช้งานที่พอร์ต 3000 แล้ว'));
