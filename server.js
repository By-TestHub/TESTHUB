const express = require('express');
const mysql = require('mysql2');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname))); // เปิดให้เข้าถึงไฟล์หน้าบ้าน index.html ได้โดยตรง

// 0. เบอร์โทรศัพท์ TrueMoney Wallet ของคุณสำหรับรับเงินซองอั่งเปา
const OWNER_PHONE = '0947643009'; 

// 1. เชื่อมต่อฐานข้อมูล MySQL (ดึงค่าจาก Environment Variables บน Render หรือใช้ค่า Default ด้านล่าง)
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'testhub_shop',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// สร้างตารางอัตโนมัติในฐานข้อมูลหากยังไม่มีระบบ
db.query(`
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        points DECIMAL(10,2) DEFAULT 0.00,
        role VARCHAR(20) DEFAULT 'user'
    )
`);

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

// 2. ระบบสมัครสมาชิก (บัญชีแรกที่สมัครในระบบจะได้เป็น Admin อัตโนมัติเพื่อทดสอบ)
app.post('/api/auth/register', (req, res) => {
    const { username, password, confirmPassword } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    if (password !== confirmPassword) return res.status(400).json({ message: 'รหัสผ่านไม่ตรงกัน' });

    db.query('SELECT * FROM users WHERE username = ?', [username], (err, results) => {
        if (err) return res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
        if (results.length > 0) return res.status(400).json({ message: 'ชื่อผู้ใช้งานนี้ถูกใช้ไปแล้ว' });

        db.query('SELECT COUNT(*) as count FROM users', (err, row) => {
            const role = row[0].count === 0 ? 'admin' : 'user';

            db.query('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, password, role], (err) => {
                if (err) return res.status(500).json({ message: 'สมัครสมาชิกส้มเหลว' });
                res.json({ message: `สมัครสมาชิกสำเร็จ! บัญชีของคุณมีสถานะเป็น: ${role}` });
            });
        });
    });
});

// 3. ระบบเข้าสู่ระบบ
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT id, username, points, role FROM users WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (err) return res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
        if (results.length === 0) return res.status(401).json({ message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
        
        res.json({ 
            message: 'เข้าสู่ระบบสำเร็จ!', 
            user: results[0] 
        });
    });
});

// 4. ดึงรายการสินค้าทั้งหมดไปโชว์หน้าแรก
app.get('/api/marketplace/products', (req, res) => {
    db.query('SELECT id, name, category, price, stock_count FROM products WHERE stock_count > 0', (err, results) => {
        if (err) return res.status(500).json({ message: 'ไม่สามารถดึงข้อมูลสินค้าได้' });
        res.json(results);
    });
});

// 5. ระบบซื้อสินค้า (เช็กพ้อยท์ -> หักพ้อยท์ -> ตัดสต็อก -> ส่งไอดีไก่ตัน)
app.post('/api/marketplace/buy', (req, res) => {
    const { userId, productId } = req.body;

    db.query('SELECT * FROM products WHERE id = ?', [productId], (err, pRes) => {
        if (err || pRes.length === 0) return res.status(404).json({ message: 'ไม่พบข้อมูลสินค้าชิ้นนี้' });
        const product = pRes[0];

        if (product.stock_count <= 0) return res.status(400).json({ message: 'ขออภัยครับ สินค้าชิ้นนี้หมดสต็อกแล้ว' });

        db.query('SELECT points FROM users WHERE id = ?', [userId], (err, uRes) => {
            if (err || uRes.length === 0) return res.status(404).json({ message: 'ไม่พบข้อมูลผู้ใช้งาน' });
            
            const userPoints = parseFloat(uRes[0].points);
            const productPrice = parseFloat(product.price);

            if (userPoints < productPrice) return res.status(400).json({ message: 'พ้อยท์ของคุณไม่เพียงพอ กรุณาเติมเงินก่อนครับ' });

            // ดำเนินการหักพ้อยท์ผู้ใช้
            db.query('UPDATE users SET points = points - ? WHERE id = ?', [productPrice, userId], (err) => {
                if (err) return res.status(500).json({ message: 'ระบบหักแต้มเกิดข้อผิดพลาด' });

                // หักจำนวนสต็อกออก 1 ชิ้น
                db.query('UPDATE products SET stock_count = stock_count - 1 WHERE id = ?', [productId], (err) => {
                    
                    // บันทึกประวัติการซื้อลงตาราง history
                    db.query('INSERT INTO history (user_id, type, description, amount) VALUES (?, ?, ?, ?)', 
                        [userId, 'buy', `ซื้อสินค้า: ${product.name}`, productPrice]);

                    // ส่งข้อมูลไอดีกลับไปแสดงผลบน Alert หน้าบ้าน
                    res.json({ 
                        message: 'ซื้อสินค้าสำเร็จแล้ว!', 
                        account_data: product.account_data || 'ไม่มีข้อมูลคีย์/ไอดีในระบบ (กรุณาติดต่อแอดมิน)',
                        pointsAdded: productPrice // ส่งไปคำนวณหักลบค่าพ้อยท์หน้าจอฝั่ง Frontend
                    });
                });
            });
        });
    });
});

// 6. ระบบเติมเงินด้วยการยิงตรวจสอบซองอั่งเปา (TrueMoney Wallet)
app.post('/api/payment/topup', async (req, res) => {
    const { userId, voucherLink } = req.body;

    if (!voucherLink.includes('gift.truemoney.com/apple-app-api/v1/redeem/')) {
        return res.status(400).json({ message: 'รูปแบบลิงก์ซองของขวัญไม่ถูกต้อง' });
    }

    const code = voucherLink.split('/redeem/')[1]?.split('?')[0];

    try {
        // ยิงไปเซิร์ฟเวอร์ทรูมันนี่เพื่อรับเงินเข้าบัญชีเบอร์ OWNER_PHONE
        const response = await axios.post(`https://gift.truemoney.com/apple-app-api/v1/redeem/${code}/co`, {
            mobile: OWNER_PHONE,
            voucher_hash: code
        }, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data.status.code === 'SUCCESS') {
            const amount = parseFloat(response.data.data.voucher.amount_baht);
            
            // เพิ่มแต้มในฐานข้อมูลให้ยูสเซอร์
            db.query('UPDATE users SET points = points + ? WHERE id = ?', [amount, userId], (err) => {
                if (err) return res.status(500).json({ message: 'โอนเงินเข้า Wallet สำเร็จแต่บันทึกแต้มลงเว็บล้มเหลว กรุณาทักหาแอดมิน' });
                
                // บันทึกประวัติการเติมเงิน
                db.query('INSERT INTO history (user_id, type, description, amount) VALUES (?, ?, ?, ?)', 
                    [userId, 'topup', `เติมเงินผ่านซองอั่งเปา รหัสซอง: ${code}`, amount]);

                res.json({ message: `เติมเงินสำเร็จ! คุณได้รับแต้มจำนวน ฿${amount} เข้าสู่บัญชีเรียบร้อย` });
            });
        } else {
            res.status(400).json({ message: 'ซองอั่งเปานี้ถูกใช้งานไปแล้ว หรือลิงก์อาจจะหมดอายุ' });
        }
    } catch (error) {
        res.status(500).json({ message: 'ไม่สามารถติดต่อเซิร์ฟเวอร์ Wallet ได้ หรือลิงก์ซองผิดพลาด' });
    }
});

// 7. ดึงประวัติธุรกรรม (ซื้อ/เติมเงิน) ของผู้ใช้แต่ละคน
app.get('/api/user/history/:userId', (req, res) => {
    const { userId } = req.params;
    db.query('SELECT type, description, amount, DATE_FORMAT(date, "%Y-%m-%d %H:%i") as date FROM history WHERE user_id = ? ORDER BY id DESC', [userId], (err, results) => {
        if (err) return res.status(500).json({ message: 'ดึงข้อมูลประวัติล้มเหลว' });
        res.json(results);
    });
});

app.listen(PORT, () => {
    console.log(`Server is running smoothly on port ${PORT}`);
});
