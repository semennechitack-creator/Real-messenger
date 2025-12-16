// ================================================================
// SERVER.JS - STAR MESSENGER BACKEND (С ЗАПРОСАМИ И АВАТАРАМИ)
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
const PORT = process.env.PORT || 3000; 

// Разрешаем CORS и JSON
app.use(cors());
app.use(bodyParser.json());

// === БЛОК ДЛЯ РАЗДАЧИ СТАТИЧЕСКИХ ФАЙЛОВ ИЗ ПАПКИ 'public' ===
app.use(express.static(path.join(__dirname, 'public')));
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
    // Добавлено поле avatar
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        online INTEGER DEFAULT 0,
        avatar TEXT DEFAULT ''
    )`);
    // Изменен статус на 'pending' или 'accepted'
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

// 1. Регистрация и Вход (оставим без изменений)
app.post('/api/register', (req, res) => { /* ... */ });
app.post('/api/login', (req, res) => { /* ... */ }); 


// 3. Поиск пользователя (Добавлено поле avatar)
app.post('/api/search', (req, res) => {
    const { query, myId } = req.body;
    // Выбираем аватар
    db.all(`SELECT id, username, avatar FROM users WHERE username LIKE ? AND id != ?`, [`%${query}%`, myId], (err, rows) => {
        if (err) return res.json({ success: false, users: [] });
        res.json({ success: true, users: rows });
    });
});

// 4. ДОБАВИТЬ ДРУГА (Отправка запроса)
app.post('/api/request-friend', (req, res) => {
    const { myId, friendId } = req.body;
    
    // Проверяем, существует ли уже запрос в обе стороны
    db.get(`SELECT status FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`, 
        [myId, friendId, friendId, myId], (err, row) => {
        
        if (row && row.status === 'accepted') {
             return res.json({ success: false, message: 'Вы уже друзья.' });
        }
        if (row && row.user_id === myId) {
             return res.json({ success: false, message: 'Запрос уже отправлен.' });
        }
        
        // Вставляем запрос только в одну сторону: myId -> friendId, статус 'pending'
        db.run(`INSERT OR IGNORE INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending')`, 
            [myId, friendId], function(err) {
            
            if (err) return res.json({ success: false, message: 'Ошибка при отправке запроса.' });
            
            // Уведомляем получателя через Socket.IO
            const targetSocket = activeSockets[friendId];
            if (targetSocket) {
                io.to(targetSocket).emit('friend_request_received', { fromId: myId });
            }
            
            res.json({ success: true, message: 'Запрос отправлен.' });
        });
    });
});


// 5. ПРИНЯТЬ ЗАПРОС
app.post('/api/accept-friend', (req, res) => {
    const { myId, requesterId } = req.body;

    db.serialize(() => {
        // 1. Обновляем статус: requester -> myId меняем на accepted
        db.run(`UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ? AND status = 'pending'`, 
            [requesterId, myId], function(err) {
                if (err || this.changes === 0) {
                    return res.json({ success: false, message: 'Запрос не найден или уже принят.' });
                }
                
                // 2. Создаем обратную связь: myId -> requester (статус сразу accepted)
                db.run(`INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted')`, 
                    [myId, requesterId], function(err) {
                        // Уведомляем обоих, что дружба установлена
                        const targetSocket = activeSockets[requesterId];
                        if (targetSocket) {
                            io.to(targetSocket).emit('friend_accepted');
                        }
                        res.json({ success: true, message: 'Запрос принят.' });
                });
        });
    });
});


// 6. СПИСОК ДРУЗЕЙ И ЗАПРОСОВ
app.post('/api/friends', (req, res) => {
    const { myId } = req.body;

    // Получаем всех, с кем есть связь (accepted и pending)
    db.all(`
        SELECT u.id, u.username, u.avatar, f.status 
        FROM users u 
        JOIN friends f ON u.id = f.friend_id 
        WHERE f.user_id = ?`, [myId], (err, rows) => {
            if (err) return res.json({ success: false, friends: [], requests: [] });
            
            // Разделяем на друзей и входящие/исходящие запросы
            const friends = [];
            const outgoingRequests = [];
            const incomingRequests = [];
            
            rows.forEach(row => {
                if (row.status === 'accepted') {
                    // Фактический друг
                    friends.push({
                        ...row,
                        isOnline: !!activeSockets[row.id]
                    });
                } else if (row.status === 'pending') {
                    // Исходящий запрос (Я отправил)
                    outgoingRequests.push(row);
                }
            });
            
            // Дополнительно ищем входящие запросы (где я - friend_id, статус pending)
            db.all(`
                SELECT u.id, u.username, u.avatar
                FROM users u 
                JOIN friends f ON u.id = f.user_id 
                WHERE f.friend_id = ? AND f.status = 'pending'`, [myId], (err, reqRows) => {
                    
                    if (err) return res.json({ success: false, friends: [], requests: [] });
                    
                    res.json({ 
                        success: true, 
                        friends: friends,
                        incomingRequests: reqRows
                    });
            });
    });
});

// 7. СМЕНА АВАТАРА
app.post('/api/set-avatar', (req, res) => {
    const { userId, avatarUrl } = req.body;
    db.run(`UPDATE users SET avatar = ? WHERE id = ?`, [avatarUrl, userId], function(err) {
        if (err || this.changes === 0) return res.json({ success: false, message: 'Ошибка обновления.' });
        res.json({ success: true, message: 'Аватар обновлен.' });
    });
});


// --- SOCKET.IO ЛОГИКА (WEBRTC SIGNALING) ---
// (Осталась прежней)
io.on('connection', (socket) => { /* ... */ });


// Запуск
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 STAR MESSENGER SERVER ЗАПУЩЕН на порту ${PORT}`);
});