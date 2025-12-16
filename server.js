// ================================================================
// SERVER.JS - STAR MESSENGER BACKEND (ФИНАЛЬНАЯ ВЕРСИЯ)
// ================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

// --- КОНФИГУРАЦИЯ ---
const app = express();
const server = http.createServer(app);
// На Render порт нужно брать из переменной окружения
const PORT = process.env.PORT || 3000; 

// Разрешаем CORS и JSON
app.use(cors());
app.use(bodyParser.json());

// === 🔑 БЛОК ДЛЯ РАЗДАЧИ СТАТИЧЕСКИХ ФАЙЛОВ ИЗ ПАПКИ 'public' ===

// 1. Указываем Express, что папка 'public' содержит статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// 2. Явный маршрут для корня сайта ('/'). Отдаем index.html.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===============================================================

// --- SOCKET.IO ---
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- БАЗА ДАННЫХ (SQLite) ---
const db = new sqlite3.Database('./messenger.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    else console.log('📁 База данных SQLite подключена.');
});

// Инициализация таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        online INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS friends (
        user_id INTEGER,
        friend_id INTEGER,
        status TEXT DEFAULT 'accepted',
        PRIMARY KEY (user_id, friend_id)
    )`);
});

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
const activeSockets = {};

// --- API ROUTES (HTTP) ---
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Заполните все поля' });
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], function(err) {
        if (err) return res.json({ success: false, error: 'Пользователь уже существует' });
        res.json({ success: true, id: this.lastID });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT id, username FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err || !row) return res.json({ success: false, error: 'Неверный логин или пароль' });
        res.json({ success: true, user: row });
    });
});

app.post('/api/search', (req, res) => {
    const { query, myId } = req.body;
    db.all(`SELECT id, username FROM users WHERE username LIKE ? AND id != ?`, [`%${query}%`, myId], (err, rows) => {
        if (err) return res.json({ success: false, users: [] });
        res.json({ success: true, users: rows });
    });
});

app.post('/api/add-friend', (req, res) => {
    const { myId, friendId } = req.body;
    db.serialize(() => {
        const stmt = db.prepare(`INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)`);
        stmt.run(myId, friendId);
        stmt.run(friendId, myId);
        stmt.finalize();
        res.json({ success: true });
    });
});

app.post('/api/friends', (req, res) => {
    const { myId } = req.body;
    db.all(`
        SELECT u.id, u.username, u.online 
        FROM users u 
        JOIN friends f ON u.id = f.friend_id 
        WHERE f.user_id = ?`, [myId], (err, rows) => {
            if (err) return res.json({ success: false, friends: [] });
            const friendsWithStatus = rows.map(f => ({
                ...f,
                isOnline: !!activeSockets[f.id]
            }));
            res.json({ success: true, friends: friendsWithStatus });
    });
});

// --- SOCKET.IO ЛОГИКА (WEBRTC SIGNALING) ---

io.on('connection', (socket) => {
    let currentUserId = null;

    socket.on('login', (userId) => {
        currentUserId = userId;
        activeSockets[userId] = socket.id;
        socket.broadcast.emit('user_status', { userId, status: true });
    });

    socket.on('chat_message', (data) => {
        const { toUserId, message, fromUserName } = data;
        const targetSocket = activeSockets[toUserId];
        if (targetSocket) {
            io.to(targetSocket).emit('chat_message', {
                fromUserId: currentUserId,
                fromUserName: fromUserName,
                message: message
            });
        }
    });

    socket.on('call_request', (data) => {
        const { toUserId, fromUserName } = data;
        const targetSocket = activeSockets[toUserId];
        if (targetSocket) {
            // Отправляем запрос на звонок (с SD P Offer)
            io.to(targetSocket).emit('call_request', {
                fromUserId: currentUserId,
                fromUserName: fromUserName,
                sdp: data.sdp 
            });
        } else {
            socket.emit('call_failed', { reason: 'User offline' });
        }
    });

    socket.on('call_answer', (data) => {
        const { toUserId, sdp } = data;
        const targetSocket = activeSockets[toUserId];
        if (targetSocket) {
            io.to(targetSocket).emit('call_answer', { sdp });
        }
    });

    socket.on('ice_candidate', (data) => {
        const { toUserId, candidate } = data;
        const targetSocket = activeSockets[toUserId];
        if (targetSocket) {
            io.to(targetSocket).emit('ice_candidate', { candidate });
        }
    });
    
    socket.on('end_call', (data) => {
        const { toUserId } = data;
        const targetSocket = activeSockets[toUserId];
        if (targetSocket) {
            io.to(targetSocket).emit('end_call');
        }
    });

    socket.on('disconnect', () => {
        if (currentUserId) {
            delete activeSockets[currentUserId];
            socket.broadcast.emit('user_status', { userId: currentUserId, status: false });
        }
    });
});

// Запуск
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 STAR MESSENGER SERVER ЗАПУЩЕН на порту ${PORT}`);
});