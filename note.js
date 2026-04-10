const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());

// 🔥 STOCKAGE EN MÉMOIRE (simple)
let settings = {
    note: "",
    selectedDate: null
};

// === GET SETTINGS ===
app.get('/api/settings', (req, res) => {
    res.json(settings);
});

// === SAVE SETTINGS ===
app.post('/api/settings', (req, res) => {
    const { note, selectedDate } = req.body;

    if (note !== undefined) {
        settings.note = note;
    }

    if (selectedDate !== undefined) {
        settings.selectedDate = selectedDate;
    }

    // 🔥 ENVOI À TOUS LES CLIENTS
    io.emit('settings_updated', settings);

    res.json({ success: true, settings });
});

// === SOCKET ===
io.on('connection', (socket) => {
    console.log('Client connecté');

    // envoyer les settings actuels
    socket.emit('settings_updated', settings);

    socket.on('disconnect', () => {
        console.log('Client déconnecté');
    });
});

// === START SERVER ===
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Serveur lancé sur http://localhost:${PORT}`);
});
