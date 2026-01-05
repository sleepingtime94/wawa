require("dotenv").config();

const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 7000;

// Konfigurasi autentikasi (ganti dengan key rahasia Anda)
const AUTH_KEY = process.env.AUTH_KEY;

// Konfigurasi MySQL
const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// Buat koneksi pool (opsional, bisa disesuaikan)
let dbPool;

// Inisialisasi WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true },
});

// Menyimpan QR terakhir untuk ditampilkan di halaman web
let currentQR = "";

client.on("qr", (qr) => {
  currentQR = qr;
  console.log("QR Code received, update index.html");
});

client.on("ready", () => {
  currentQR = "";
  console.log("Client is ready!");
});

client.on("authenticated", () => {
  console.log("Authenticated");
});

client.initialize();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Route untuk menampilkan QR code
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Endpoint untuk mengambil QR code terbaru
app.get("/qr", (req, res) => {
  res.type("text/plain");
  res.send(currentQR || "");
});

// Route untuk mengirim pesan
app.post("/send-message", async (req, res) => {
  const { key, phone, message } = req.body;

  // Validasi key
  if (key !== AUTH_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Validasi input
  if (!phone || !message) {
    return res.status(400).json({ error: "Phone and message are required" });
  }

  let normalizedPhone;

  try {
    normalizedPhone = normalizePhone(phone);
  } catch (err) {
    return res
      .status(400)
      .json({ error: "Invalid phone number", details: err.message });
  }

  const to = `${normalizedPhone}@c.us`;

  const from = process.env.SENDER_CLIENT_ID;
  const created = new Date();

  try {
    if (!client.info) {
      throw new Error("Client not ready");
    }

    const chatId = to;
    await client.sendMessage(chatId, message);
    const status = "success";

    // Simpan ke DB
    await logMessageToDB(from, to, message, status, created);

    res.json({ status: "Message sent successfully" });
  } catch (err) {
    console.error("Send error:", err.message);
    const status = "failed";
    await logMessageToDB(from, to, message, status, created);
    res
      .status(500)
      .json({ error: "Failed to send message", details: err.message });
  }
});

// Fungsi simpan log ke MySQL
async function logMessageToDB(from, to, message, status, created) {
  if (!dbPool) {
    dbPool = await mysql.createPool(DB_CONFIG);
  }
  const query = `
    INSERT INTO message_logs (\`from\`, \`to\`, \`message\`, \`status\`, \`created_at\`)
    VALUES (?, ?, ?, ?, ?)
  `;
  await dbPool.execute(query, [from, to, message, status, created]);
}

// Inisialisasi tabel jika belum ada
async function initDB() {
  const connection = await mysql.createConnection(DB_CONFIG);
  await connection.execute(`
    CREATE DATABASE IF NOT EXISTS whatsapp_gateway;
  `);
  await connection.end();

  dbPool = await mysql.createPool(DB_CONFIG);
  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      \`from\` VARCHAR(50),
      \`to\` VARCHAR(50),
      \`message\` TEXT,
      \`status\` ENUM('success', 'failed') NOT NULL,
      \`created_at\` DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

function normalizePhone(phone) {
  // Hapus semua karakter non-digit
  let clean = phone.replace(/\D/g, "");

  // Jika dimulai dengan '0', ganti menjadi '62'
  if (clean.startsWith("0")) {
    clean = "62" + clean.slice(1);
  }
  // Jika dimulai dengan '62' dan panjangnya > 10, anggap valid (tidak diubah)
  // Tapi pastikan tidak ada '62' ganda
  else if (clean.startsWith("628") || clean.startsWith("62")) {
    // Biarkan apa adanya, asumsikan sudah format internasional
  }
  // Opsional: jika mulai dengan '8' (kasus sangat langka), tambahkan '62'
  else if (clean.startsWith("8")) {
    clean = "62" + clean;
  }

  // Validasi minimal panjang (nomor HP Indonesia: 10–13 digit setelah 62)
  if (clean.length < 10 || clean.length > 14 || !clean.startsWith("62")) {
    throw new Error("Invalid phone number format");
  }

  return clean;
}

// Jalankan server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
