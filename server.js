const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
// 1. ИСПРАВЛЕНИЕ: Добавлен модуль CORS
const cors = require('cors'); 

const app = express();
const server = http.createServer(app);
const DATA_FILE = 'data.json';
const UPLOADS_DIR = 'public/uploads';

// --- НАСТРОЙКА CORS ДЛЯ HTTP/EXPRESS ---
// Это разрешает запросы с вашего публичного домена Render
app.use(cors()); 
// ----------------------------------------

// --- НАСТРОЙКА ХРАНИЛИЩА ФАЙЛОВ (MULTER) ---
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const fileExtension = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + fileExtension);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});
// ---------------------------------------------

// Настройка Express
app.use(express.static('public')); 
app.use(express.json());

// --- DATABASE (Simple JSON File) ---
let db = { users: {}, messages: [] };
if (fs.existsSync(DATA_FILE)) {
    // ИСПРАВЛЕНИЕ: Проверка файла JSON должна быть внутри try-catch на случай его повреждения
    try {
        db = JSON.parse(fs.readFileSync(DATA_FILE));
    } catch (e) {
        console.error("Error reading data.json:", e);
        // Если файл поврежден, начинаем с пустого DB
        db = { users: {}, messages: [] };
    }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// --- API ROUTES (Auth & Upload & Messages) ---
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (db.users[username]) return res.json({ success: false, message: 'User exists' });
    
    db.users[username] = { password, avatar: '👤' };
    saveData();
    res.json({ success: true });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.users[username];
    if (user && user.password === password) {
        res.json({ success: true, username });
    } else {
        res.json({ success: false, message: 'Invalid credentials' });
    }
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ 
        success: true, 
        url: fileUrl, 
        originalName: req.file.originalname, 
        mimeType: req.file.mimetype 
    });
});

app.get('/messages', (req, res) => {
    res.json(db.messages);
});


// 2. ИСПРАВЛЕНИЕ: Настройка Socket.IO с CORS
const io = new Server(server, {
    cors: {
        origin: "*", // Разрешить подключение с любого Origin
        methods: ["GET", "POST"]
    }
});
// ----------------------------------------


// --- REAL-TIME SOCKETS & WEBRTC SIGNALING ---
const onlineUsers = new Map();
const usernameToSocketId = new Map();

io.on('connection', (socket) => {
    
    socket.on('user_connected', (username) => {
        if (!username) return; 
        onlineUsers.set(socket.id, username);
        usernameToSocketId.set(username, socket.id);
        io.emit('update_user_list', Array.from(new Set(onlineUsers.values())));
    });

    socket.on('send_message', (data) => {
        const { to, from, text, url, originalName, mimeType, isVoice } = data; 
        
        const msg = { 
            to, 
            from, 
            text, 
            url, 
            originalName, 
            mimeType,
            isVoice: isVoice || false,
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) 
        };
        
        db.messages.push(msg);
        saveData();

        socket.emit('receive_message', msg); 

        const recipientSocketId = usernameToSocketId.get(to);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('receive_message', msg);
        }
    });
    
    socket.on('call_user', (data) => {
        const userToCallSocketId = usernameToSocketId.get(data.userToCall);
        if (userToCallSocketId) {
            io.to(userToCallSocketId).emit('incoming_call', { 
                from: data.from, 
                offer: data.offer,
                isVideo: data.isVideo
            });
        }
    });

    socket.on('answer_call', (data) => {
        const callerSocketId = usernameToSocketId.get(data.to);
        if (callerSocketId) {
            io.to(callerSocketId).emit('call_accepted', { 
                answer: data.answer 
            });
        }
    });

    socket.on('ice_candidate', (data) => {
        const targetSocketId = usernameToSocketId.get(data.to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('ice_candidate', data.candidate);
        }
    });

    socket.on('call_ended', (data) => {
        const targetSocketId = usernameToSocketId.get(data.to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('call_ended');
        }
    });

    socket.on('disconnect', () => {
        const disconnectedUsername = onlineUsers.get(socket.id);
        onlineUsers.delete(socket.id);
        if (disconnectedUsername) {
             usernameToSocketId.delete(disconnectedUsername);
        }
        io.emit('update_user_list', Array.from(new Set(onlineUsers.values())));
    });
});

// 3. ИСПРАВЛЕНИЕ: Использование порта из переменной окружения Render
const PORT = process.env.PORT || 4000; 
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});