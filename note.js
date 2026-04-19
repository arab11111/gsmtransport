const fs = require('fs');
const path = require('path');
const { verifyFirebaseToken, requireAdmin } = require('./lib/auth');

module.exports = function(app, io){
    // POST /api/note -> save note.json and emit note_updated
    // Protected: only admins may create/update the note
    app.post('/api/note', verifyFirebaseToken, requireAdmin, (req, res) => {
        try {
            const { note, date } = req.body || {};
            const data = {
                note: note || '',
                date: date || null
            };

            fs.writeFileSync(path.join(__dirname, 'note.json'), JSON.stringify(data, null, 2));

            // notify all connected clients
            io.emit('note_updated', data);
            // also emit settings_updated for compatibility with clients listening for settings
            try {
                io.emit('settings_updated', { note: data.note, selectedDate: data.date || null });
            } catch (e) { console.warn('emit settings_updated failed', e); }

            res.json({ success: true, settings: data });
        } catch (err) {
            console.error('Erreur sauvegarde note:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/note -> read note.json (public)
    app.get('/api/note', (req, res) => {
        try {
            const file = path.join(__dirname, 'note.json');
            if (!fs.existsSync(file)) return res.json({ note: '', date: null });
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            res.json(data);
        } catch (err) {
            console.error('Erreur lecture note:', err);
            res.status(500).json({ error: err.message });
        }
    });
};
