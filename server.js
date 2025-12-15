const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const DATA_FILE = 'data.json';
const UPLOADS_DIR = 'public/uploads';

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
    // ИСПРАВЛЕНИЕ: Добавлена закрывающая скобка ')'
    db = JSON.parse(fs.readFileSync(DATA_FILE));
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
        usernameToSocketId.delete(disconnectedUsername);
        io.emit('update_user_list', Array.from(new Set(onlineUsers.values())));
    });
});

const PORT = 4000;
server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}/index.html`);
});