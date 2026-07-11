const express = require('express');
const mysql = require('mysql2');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname))); // ให้เข้าถึงไฟล์ index.html ได้

// 1. เชื่อมต่อฐานข้อมูล MySQL (ดึงค่าจาก Environment Variables บน Render)
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'testhub_shop',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// สร้างตารางอัตโนมัติถ้ายังไม่มีในระบบ
db.query(`
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        points DECIMAL(10,2) DEFAULT 0.00,
        role VARCHAR(20) DEFAULT 'user'
    )
`, (err) => { if (err) console.error("สร้างตาราง users ล้มเหลว:", err); });

db.query(`
    CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        stock_count INT DEFAULT 0,
        account_data TEXT
    )
`);

db.query(`
    CREATE TABLE IF NOT EXISTS history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        type VARCHAR(20),
        description VARCHAR(255),
        amount DECIMAL(10,2),
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

// ================= API ROUTES =================

// 2. ระบบสมัครสมาชิก
app.post('/api/auth/register', (req, res) => {
    const { username, password, confirmPassword } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    if (password !== confirmPassword) return res.status(400).json({ message: 'รหัสผ่านไม่ตรงกัน' });

    // ตรวจสอบว่ามีชื่อผู้ใช้นี้หรือยัง
    db.query('SELECT * FROM users WHERE username = ?', [username], (err, results) => {
        if (results.length > 0) return res.status(400).json({ message: 'ชื่อผู้ใช้งานนี้ถูกใช้ไปแล้ว' });

        // เพื่อความง่ายในการเริ่มต้นจะเก็บแบบข้อความธรรมดา (ในอนาคตแนะนำให้ใช้ bcrypt แฮชรหัสผ่าน)
        // บัญชีแรกที่สมัครจะตั้งให้เป็นแอดมินอัตโนมัติเพื่อทดสอบระบบ
        db.query('SELECT COUNT(*) as count FROM users', (err, row) => {
            const role = row[0].count === 0 ? 'admin' : 'user';

            db.query('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, password, role], (err, result) => {
                if (err) return res.status(500).json({ message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
                res.json({ message: `สมัครสมาชิกสำเร็จ! บัญชีของคุณมีสถานะเป็น: ${role}` });
            });
        });
    });
});

// 3. ระบบเข้าสู่ระบบ
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT id, username, points, role FROM users WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
        
        res.json({ 
            message: 'เข้าสู่ระบบสำเร็จ!', 
            user: results[0] 
        });
    });
});

// 4. ดึงรายการสินค้าทั้งหมด
app.get('/api/marketplace/products', (req, res) => {
    db.query('SELECT id, name, category, price, stock_count FROM products WHERE stock_count > 0', (err, results) => {
        if (err) return res.status(500).json({ message: 'ไม่สามารถดึงข้อมูลสินค้าได้' });
        res.json(results);
    });
});

// 5. ระบบเติมเงินด้วยซองอั่งเปา (TrueMoney Wallet)
app.post('/api/payment/topup', async (req, res) => {
    const { userId, voucherLink } = req.body;
    
    // ดึงเบอร์โทรศัพท์ทรูมันนี่ของคุณจาก Environment Variable
    const myMobileNumber = 0947643009

    if (!voucherLink.includes('gift.truemoney.com/apple-app-api/v1/redeem/')) {
        return res.status(400).json({ message: 'ลิงก์ซองของขวัญไม่ถูกต้อง' });
    }

    const code = voucherLink.split('/redeem/')[1]?.split('?')[0];

    try {
        // ยิงไปตรวจสอบและรับเงินจาก API TrueMoney Wallet จริง
        const response = await axios.post(`https://gift.truemoney.com/apple-app-api/v1/redeem/${code}/co`, {
            mobile: myMobileNumber,
            voucher_hash: code
        }, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data.status.code === 'SUCCESS') {
            const amount = parseFloat(response.data.data.voucher.amount_baht);
            
            // อัปเดตพ้อยท์ให้ผู้ใช้ใน Database
            db.query('UPDATE users SET points = points + ? WHERE id = ?', [amount, userId], (err) => {
                if (err) return res.status(500).json({ message: 'เติมเงินสำเร็จแต่บันทึกแต้มล้มเหลว กรุณาติดต่อแอดมิน' });
                
                // บันทึกประวัติ
                db.query('INSERT INTO history (user_id, type, description, amount) VALUES (?, ?, ?, ?)', 
                    [userId, 'topup', `เติมเงินผ่านซองอั่งเปา อ้างอิง: ${code}`, amount]);

                res.json({ message: `เติมเงินสำเร็จเรียบร้อย ได้รับเงินจำนวน ฿${amount}` });
            });
        } else {
            res.status(400).json({ message: 'ซองอั่งเปานี้ถูกใช้งานไปแล้วหรือลิงก์หมดอายุ' });
        }
    } catch (error) {
        res.status(500).json({ message: 'ไม่สามารถเชื่อมต่อกับระบบ TrueMoney ได้ในขณะนี้ หรือซองไม่ถูกต้อง' });
    }
});

// 6. ดึงประวัติการทำรายการของผู้ใช้
app.get('/api/user/history/:userId', (req, res) => {
    const { userId } = req.params;
    db.query('SELECT type, description, amount, DATE_FORMAT(date, "%Y-%m-%d %H:%i") as date FROM history WHERE user_id = ? ORDER BY id DESC', [userId], (err, results) => {
        if (err) return res.status(500).json({ message: 'ดึงประวัติล้มเหลว' });
        res.json(results);
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
