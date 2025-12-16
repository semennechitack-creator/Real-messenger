// ================================================================
// SERVER.JS - STAR MESSENGER BACKEND
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
const PORT = 3000;

// Разрешаем CORS для мобильного подключения
app.use(cors());
app.use(bodyParser.json());

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
    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        online INTEGER DEFAULT 0
    )`);

    // Таблица друзей (связи)
    db.run(`CREATE TABLE IF NOT EXISTS friends (
        user_id INTEGER,
        friend_id INTEGER,
        status TEXT DEFAULT 'accepted',
        PRIMARY KEY (user_id, friend_id)
    )`);
});

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
// Хранилище активных сокетов: { userId: socketId }
const activeSockets = {};

// --- API ROUTES (HTTP) ---

// 1. Регистрация
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Заполните все поля' });

    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], function(err) {
        if (err) return res.json({ success: false, error: 'Пользователь уже существует' });
        res.json({ success: true, id: this.lastID });
    });
});

// 2. Вход
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT id, username FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err || !row) return res.json({ success: false, error: 'Неверный логин или пароль' });
        res.json({ success: true, user: row });
    });
});

// 3. Поиск пользователя
app.post('/api/search', (req, res) => {
    const { query, myId } = req.body;
    db.all(`SELECT id, username FROM users WHERE username LIKE ? AND id != ?`, [`%${query}%`, myId], (err, rows) => {
        if (err) return res.json({ success: false, users: [] });
        res.json({ success: true, users: rows });
    });
});

// 4. Добавить друга
app.post('/api/add-friend', (req, res) => {
    const { myId, friendId } = req.body;
    // Добавляем двустороннюю связь
    db.serialize(() => {
        const stmt = db.prepare(`INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)`);
        stmt.run(myId, friendId);
        stmt.run(friendId, myId);
        stmt.finalize();
        res.json({ success: true });
    });
});

// 5. Список друзей
app.post('/api/friends', (req, res) => {
    const { myId } = req.body;
    db.all(`
        SELECT u.id, u.username, u.online 
        FROM users u 
        JOIN friends f ON u.id = f.friend_id 
        WHERE f.user_id = ?`, [myId], (err, rows) => {
            if (err) return res.json({ success: false, friends: [] });
            
            // Добавляем статус онлайн из активных сокетов
            const friendsWithStatus = rows.map(f => ({
                ...f,
                isOnline: !!activeSockets[f.id]
            }));
            res.json({ success: true, friends: friendsWithStatus });
    });
});

// --- SOCKET.IO ЛОГИКА ---

io.on('connection', (socket) => {
    console.log(`[Socket] Подключение: ${socket.id}`);
    let currentUserId = null;

    // Вход пользователя в сеть
    socket.on('login', (userId) => {
        currentUserId = userId;
        activeSockets[userId] = socket.id;
        console.log(`[Auth] User ${userId} теперь онлайн (Socket ${socket.id})`);
        socket.broadcast.emit('user_status', { userId, status: true });
    });

    // Текстовое сообщение (ТОЛЬКО ДРУЗЬЯМ)
    socket.on('chat_message', (data) => {
        const { toUserId, message, fromUserName } = data;
        const targetSocket = activeSockets[toUserId];

        // Проверка дружбы перед отправкой (упрощено, но в идеале нужно делать запрос к БД)
        if (targetSocket) {
            io.to(targetSocket).emit('chat_message', {
                fromUserId: currentUserId,
                fromUserName: fromUserName,
                message: message
            });
        }
    });

    // --- WEBRTC SIGNALING (Звонки) ---
    
    // Запрос на звонок
    socket.on('call_request', (data) => {
        const { toUserId, fromUserName } = data;
        const targetSocket = activeSockets[toUserId];
        
        if (targetSocket) {
            console.log(`[Call] Звонок от ${currentUserId} к ${toUserId}`);
            io.to(targetSocket).emit('call_request', {
                fromUserId: currentUserId,
                fromUserName: fromUserName,
                sdp: data.sdp // Offer
            });
        } else {
            socket.emit('call_failed', { reason: 'User offline' });
        }
    });

    // Ответ на звонок (Answer)
    socket.on('call_answer', (data) => {
        const { toUserId, sdp } = data;
        const targetSocket = activeSockets[toUserId];
        if (targetSocket) {
            io.to(targetSocket).emit('call_answer', { sdp });
        }
    });

    // ICE Candidates (Пути соединения)
    socket.on('ice_candidate', (data) => {
        const { toUserId, candidate } = data;
        const targetSocket = activeSockets[toUserId];
        if (targetSocket) {
            io.to(targetSocket).emit('ice_candidate', { candidate });
        }
    });
    
    // Завершение звонка
    socket.on('end_call', (data) => {
        const { toUserId } = data;
        const targetSocket = activeSockets[toUserId];
        if (targetSocket) {
            io.to(targetSocket).emit('end_call');
        }
    });

    // Отключение
    socket.on('disconnect', () => {
        if (currentUserId) {
            delete activeSockets[currentUserId];
            socket.broadcast.emit('user_status', { userId: currentUserId, status: false });
            console.log(`[Auth] User ${currentUserId} отключился`);
        }
    });
});

// Запуск
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 STAR MESSENGER SERVER ЗАПУЩЕН
    🔗 Адрес: http://localhost:${PORT}
    📲 Не забудьте обновить IP в index.html!
    `);
});