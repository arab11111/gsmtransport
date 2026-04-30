const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const PDFDocument = require('pdfkit');
let admin = null;
try {
  admin = require('firebase-admin');
} catch (e) {
  console.log('⚠️ Firebase non installé → ignoré');
}
// Helper to require files from possible lib locations (handles different build layouts)
function tryRequireLib(moduleName) {
  const candidates = [
    path.join(__dirname, 'lib', moduleName + '.js'),
    path.join(__dirname, 'lib', moduleName),
    path.join(__dirname, '..', 'lib', moduleName + '.js'),
    path.join(__dirname, '..', 'lib', moduleName),
    path.join(process.cwd(), 'lib', moduleName + '.js'),
    path.join(process.cwd(), 'lib', moduleName)
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return require(p);
    } catch (e) {}
  }

  console.warn(`⚠️ Module ${moduleName} introuvable → ignoré`);
  return null; // ❗ ne plus crash
}

// Mongo removed — rely on Firebase (Firestore) and JSON fallback
const initMongo = async () => null;
const getDb = () => null;
const ObjectId = null;

// Departures
const mountDepartures = tryRequireLib('departures') || (() => {});

// Auth
const authLib = tryRequireLib('auth') || {};
const verifyFirebaseToken = authLib.verifyFirebaseToken || ((req, res, next) => next());
const requireAdmin = authLib.requireAdmin || ((req, res, next) => next());
const isAdminEmail = authLib.isAdminEmail || (() => false);
const app = express();
const server = http.createServer(app);

// ✅ socket.io (compatible Render)
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ✅ Try to initialize Firebase Admin (optional). If not available, fall back to JSON files.
let adminDb = null;
// try MongoDB first (async initialization)
initMongo().catch(() => {});
try {
  // prefer explicit service account file if present
  let serviceAccount = null;
  try { serviceAccount = require('./serviceAccountKey.json'); } catch (e) { /* ignore */ }

  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    adminDb = admin.firestore();
    console.log('✅ Firebase Admin initialisé (serviceAccountKey.json)');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp();
    adminDb = admin.firestore();
    console.log('✅ Firebase Admin initialisé (ADC)');
  } else {
    console.log('⚠️ Firebase Admin non configuré — fallback JSON activé');
  }
} catch (e) {
  console.warn('Erreur initialisation Firebase Admin:', e);
}

// ==============================
// 🔥 SAVE NOTIFICATION (Firestore + JSON fallback)
// ==============================
async function saveNotification(data) {
  const payload = {
    ...data,
    createdAt: new Date().toISOString(),
    read: false
  };

  try {
    // Firestore (preferred) — or fallback to JSON persistence
    if (adminDb) {
      await adminDb.collection('notifications').add(payload);
      console.log('✅ Notification sauvegardée Firestore');
    } else {
      console.log('⚠️ Aucun DB configuré, notification persistée en JSON seulement');
    }

    // ✅ fallback JSON (always keep JSON persistence)
    persistNotification(payload);

  } catch (error) {
    console.error('❌ Erreur saveNotification:', error);
  }
}

// 📁 dossier PDF
const pdfsDir = path.join(__dirname, 'pdfs');

// protect against duplicated PDF generation (in-memory de-dup)
const generatedPdfs = new Set();
// ensure pdfs directory exists (async, non-blocking)
(async () => {
  try { await fsp.mkdir(pdfsDir, { recursive: true }); } catch (e) { /* ignore */ }
})();

// 📁 middlewares
app.use('/pdfs', express.static(pdfsDir));
app.use(express.static(path.join(__dirname)));
app.use(express.json());


// ==============================
// 🔔 Notifications JSON
// ==============================
async function persistNotification(obj){
  try{
    const file = path.join(__dirname, 'notifications.json');
    let arr = [];

    try{
      await fsp.access(file);
      try{
        const raw = await fsp.readFile(file, 'utf8');
        arr = JSON.parse(raw || '[]');
      } catch(e){ arr = []; }
    } catch(e){ arr = []; }

    arr.unshift({
      ...obj,
      receivedAt: new Date().toISOString(),
      read: false
    });

    if (arr.length > 200) arr = arr.slice(0,200);

    await fsp.writeFile(file, JSON.stringify(arr, null, 2));
  }catch(e){
    console.error('persistNotification error', e);
  }
}


// ==============================
// 🏠 ROUTE PRINCIPALE
// ==============================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// ==============================
// 📄 UPLOAD PDF
// ==============================
app.post('/upload-pdf', async (req, res) => {
  const filename = req.query.filename || `file_${Date.now()}.pdf`;
  const filePath = path.join(pdfsDir, path.basename(filename));

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));

  req.on('end', async () => {
    try {
      await fsp.writeFile(filePath, Buffer.concat(chunks));

      res.json({ success: true, url: `/pdfs/${path.basename(filename)}` });

      try { io.emit('pdf_generated', { filename: path.basename(filename), url: `/pdfs/${path.basename(filename)}` }); } catch(e){}
    } catch (err) {
      console.error('upload-pdf write error', err);
      try { if (!res.headersSent) res.status(500).json({ error: err.message }); } catch(e){}
    }
  });
});


// ==============================
// 🔌 SOCKET.IO
// ==============================
// authenticate socket connections using Firebase ID token (handshake.auth.token)
io.use(async (socket, next) => {
  try {
    if (!admin || !admin.auth) return next(); // allow anonymous if admin not configured
    const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(); // allow anonymous sockets for public features
    const decoded = await admin.auth().verifyIdToken(token);
    socket.user = decoded;
    return next();
  } catch (err) {
    console.warn('Socket auth failed', err && err.message);
    return next(new Error('Auth error'));
  }
});

io.on('connection', async (socket) => {
  console.log('Client connecté:', socket.id);

  // 🔔 envoyer anciennes notifications (JSON fallback)
  try {
    const notifFile = path.join(__dirname, 'notifications.json');
    try {
      await fsp.access(notifFile);
      const raw = await fsp.readFile(notifFile, 'utf8');
      const list = JSON.parse(raw || '[]');
      if (list && list.length) socket.emit('pending_notifications', list);
    } catch (e) { /* no notifications file or read error */ }
  } catch (e) {}

  // 🔥 Charger anciennes réservations Firestore si disponible (envoi au client connecté)
  try {
    if (adminDb) {
      const snap = await adminDb
        .collection('bookings')
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();

      const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (list.length) socket.emit('pending_notifications', list);
    }
  } catch (e) { console.warn('load firestore bookings failed', e); }

  // =====================
  // 📦 NOUVELLE RESERVATION (génération PDF + sauvegarde Firestore si dispo)
  // =====================
  async function generatePDF(data) {
    return new Promise((resolve, reject) => {
      try {
        const sanitize = s => (s || '').toString().replace(/[^a-zA-Z0-9-_.]/g, '_');
        const safeNum = sanitize(data.bagage_numero || data.id || Date.now());
        const filename = `reservation_${safeNum}.pdf`;
        const filePath = path.join(pdfsDir, filename);
        const stream = fs.createWriteStream(filePath);
        const doc = new PDFDocument({ size: 'A4', margin: 40 });

        doc.pipe(stream);

        doc.fontSize(20).text('GSM Transport', { align: 'center' });
        doc.moveDown();
        doc.fontSize(16).text('Réservation Bagage', { align: 'center' });
        doc.moveDown();
        // Matricule: prefer explicit field, otherwise try to parse from bagage_numero (format: MATRICULE/BAG-...)
        let matricule = data.matricule || '';
        if (!matricule && data.bagage_numero && data.bagage_numero.includes('/')) matricule = data.bagage_numero.split('/')[0];
        if (matricule) {
          doc.fontSize(12).text(`Matricule: ${matricule}`);
        }

        doc.fontSize(12).text(`Numéro: ${data.bagage_numero}`);
        doc.text(`Expéditeur: ${data.exp_nom} ${data.exp_prenom}`);
        doc.text(`Destinataire: ${data.dest_nom} ${data.dest_prenom}`);
        if (data.exp_tel) doc.text(`Téléphone exp: ${data.exp_tel}`);
        if (data.dest_tel) doc.text(`Téléphone dest: ${data.dest_tel}`);
        if (data.pays_dest || data.destination) doc.text(`Destination: ${data.pays_dest || ''} ${data.destination || ''}`);
        if (data.nb_bagages) doc.text(`Bagages: ${data.nb_bagages}`);
        if (data.poids) doc.text(`Poids: ${data.poids} kg`);
        if (data.prix) doc.text(`Prix: ${data.prix} €`);

        if (data.notes) {
          doc.moveDown();
          doc.text(`Note: ${data.notes}`);
        }

        doc.end();

        stream.on('finish', () => resolve(`/pdfs/${filename}`));
        stream.on('error', (err) => reject(err));
      } catch (err) { reject(err); }
    });
  }

  

  // Clients may emit a lightweight booking notification event to quickly
  // inform the server to broadcast to admins (useful as a realtime ACK).
  socket.on('client_booking', async (data) => {
    try {
      const payload = { ...(data || {}), createdAt: new Date().toISOString(), read: false };
      try { persistNotification({ ...payload, type: 'booking' }); } catch (e) { console.warn('persistNotification failed', e); }
      try { io.emit('booking_notification', payload); } catch (e) { console.warn('emit booking_notification failed', e); }
    } catch (e) { console.warn('client_booking handler error', e); }
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté:', socket.id);
  });
});


// ==============================
// ⚙️ SETTINGS (DATE + NOTE)
// ==============================

// GET
app.get('/api/settings', async (req, res) => {
  try {
    const file = path.join(__dirname, 'settings.json');

    try {
      await fsp.access(file);
      const raw = await fsp.readFile(file, 'utf8');
      return res.json(JSON.parse(raw || '{}'));
    } catch (e) {
      return res.json({ note: '', selectedDate: null });
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST
// Allow simple site settings updates without requiring Firebase/MongoDB.
// When `selectedDate` is not provided by the client, generate it server-side
// (YYYY-MM-DD) so admin can simply click "Enregistrer" to publish a date.
app.post('/api/settings', async (req, res) => {
  try {
    const { note } = req.body || {};
    const providedDate = req.body && req.body.selectedDate;
    const generatedDate = providedDate || new Date().toISOString().slice(0, 10);

    const file = path.join(__dirname, 'settings.json');

    let cur = {};
    try { await fsp.access(file); const raw = await fsp.readFile(file,'utf8'); cur = JSON.parse(raw||'{}'); } catch(e){ cur = {}; }

    const next = {
      ...cur,
      ...(note !== undefined ? { note } : {}),
      selectedDate: generatedDate
    };

    await fsp.writeFile(file, JSON.stringify(next, null, 2));
    try { io.emit('settings_updated', next); } catch (e) { /* ignore */ }

    return res.json(next);
  } catch (err) {
    console.error('POST /api/settings error', err);
    return res.status(500).json({ error: err.message });
  }
});

  // ===== DATES endpoints (moved inline) =====
  try {
  const datesFile = path.join(__dirname, 'dates.json');
  const settingsFile = path.join(__dirname, 'settings.json');

  async function readDates(){
    try { await fsp.access(datesFile); const raw = await fsp.readFile(datesFile, 'utf8'); return JSON.parse(raw || '[]'); } catch(e){ return []; }
  }
  async function writeDates(dates){ try{ await fsp.writeFile(datesFile, JSON.stringify(dates, null, 2)); } catch(e){ console.error('writeDates error', e); } }

  app.get('/api/dates', async (req, res) => {
    try { const d = await readDates(); return res.json(d); } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.post('/api/dates', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
      const { dates, active } = req.body;
      if (!Array.isArray(dates)) return res.status(400).json({ error: 'dates must be array' });
      let cur = await readDates();
      const set = new Set(cur);
      if (active) dates.forEach(d => set.add(d)); else dates.forEach(d => set.delete(d));
      const next = Array.from(set).sort();
      await writeDates(next);
      try { io.emit('departures_updated', { dates: next }); } catch (e) { console.warn('emit departures_updated failed', e); }
      return res.json({ success: true, dates: next });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.post('/api/dates/single', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
      const { date, active } = req.body;
      if (!date) return res.status(400).json({ error: 'date required' });
      let cur = await readDates();
      const set = new Set(cur);
      if (active) set.add(date); else set.delete(date);
      const next = Array.from(set).sort();
      await writeDates(next);
      try { io.emit('departures_updated', { dates: next }); } catch (e) { console.warn('emit departures_updated failed', e); }

      // persist selectedDate into settings.json and broadcast
      try {
        let settings = {};
        try { await fsp.access(settingsFile); const raw = await fsp.readFile(settingsFile,'utf8'); settings = JSON.parse(raw||'{}'); } catch(e){ settings = {}; }
        settings.selectedDate = active ? date : null;
        await fsp.writeFile(settingsFile, JSON.stringify(settings, null, 2));
        try { io.emit('settings_updated', settings); } catch (e) { console.warn('emit settings_updated failed', e); }
      } catch (e) { console.warn('failed to persist settings selectedDate', e); }

      return res.json({ success: true, dates: next });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/dates/:date', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
      const date = decodeURIComponent(req.params.date);
      let cur = await readDates();
      const next = cur.filter(d => d !== date);
      await writeDates(next);
      try { io.emit('departures_updated', { dates: next }); } catch (e) { console.warn('emit departures_updated failed', e); }

      // if removed date was selected, clear selectedDate in settings
      try {
        try { await fsp.access(settingsFile); const raw = await fsp.readFile(settingsFile,'utf8'); const settings = JSON.parse(raw||'{}'); if (settings.selectedDate === date) { settings.selectedDate = null; await fsp.writeFile(settingsFile, JSON.stringify(settings, null, 2)); try { io.emit('settings_updated', settings); } catch(e){} } } catch (e) { /* ignore no settings file */ }
      } catch (e) { console.warn('failed to update settings on date delete', e); }

      return res.json({ success: true, dates: next });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

} catch (e) { console.warn('dates endpoints setup failed', e); }

try {
  mountDepartures(app, io);
} catch (e) { console.warn('Could not load departures module', e); }


// ==============================
// 🚀 START SERVER
// ==============================
const PORT = process.env.PORT || 3002;

server.listen(PORT, () => {
  console.log('Serveur lancé sur port', PORT);
});

// ==============================
// 🔔 GET NOTIFICATIONS
// ==============================
app.get('/api/notifications', async (req, res) => {
  try {

    // 🔥 Firestore prioritaire
    if (adminDb) {
      const snapshot = await adminDb
        .collection('notifications')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();

      const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      return res.json(list);
    }

    // fallback JSON
    const file = path.join(__dirname, 'notifications.json');

    try {
      await fsp.access(file);
      const raw = await fsp.readFile(file, 'utf8');
      const list = JSON.parse(raw || '[]');
      return res.json(list);
    } catch (e) {
      return res.json([]);
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================
// 📌 MARK NOTIFICATION AS READ (optional)
// ==============================
app.post('/api/notifications/read/:id', async (req, res) => {
  try {
    const id = req.params.id;

    const mongo = getDb();
    if (mongo) {
      try {
        await mongo.collection('notifications').updateOne({ _id: ObjectId(id) }, { $set: { read: true } });
        return res.json({ success: true });
      } catch (e) {
        // if id is not an ObjectId, try to update by string id field
        await mongo.collection('notifications').updateOne({ id: id }, { $set: { read: true } });
        return res.json({ success: true });
      }
    }

    if (adminDb) {
      await adminDb.collection('notifications').doc(id).update({ read: true });
      return res.json({ success: true });
    }

    // fallback: not implemented for JSON (no stable id)
    return res.json({ success: false, message: 'No DB configured, fallback not implemented' });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================
// 📦 SAVE BOOKING (Firestore + JSON fallback)
// ==============================
app.post('/api/bookings', async (req, res) => {
  try {
    const data = req.body || {};

    const booking = {
      ...data,
      createdAt: new Date().toISOString()
    };
    // 🔥 MONGODB
      const mongo = getDb();
      let savedId = null;
      if (mongo) {
        try {
          const r = await mongo.collection('bookings').insertOne(booking);
          savedId = (r.insertedId || '').toString();
        } catch (e) { console.warn('mongo insert failed', e); }
      }

    // 🔥 FIRESTORE
    if (adminDb) {
      try {
        const ref = await adminDb.collection('bookings').add(booking);
        savedId = ref.id;
      } catch (e) { console.warn('firestore add failed', e); }
    }

    // 📁 FALLBACK JSON
    const file = path.join(__dirname, 'bookings.json');
    let list = [];
    try { await fsp.access(file); const raw = await fsp.readFile(file,'utf8'); list = JSON.parse(raw||'[]'); } catch(e){ list = []; }

    // If we reached here and have savedId (mongo or firestore), still persist in JSON list for fallback
    list.unshift(booking);
    try { await fsp.writeFile(file, JSON.stringify(list, null, 2)); } catch(e){ console.warn('write bookings.json failed', e); }
    // Emit immediate booking notification so admin sees reservation quickly
    try { io.emit('booking_notification', booking); } catch (e) { console.warn('emit immediate booking_notification failed', e); }

    // Generate PDF and emit notification in all cases (non-blocking)
    (async () => {
      try {
        const sanitize = s => (s || '').toString().replace(/[^a-zA-Z0-9-_.]/g, '_');
        const id = booking.bagage_numero || savedId || Date.now();
        const safeId = sanitize(id);

        // Avoid generating the same PDF multiple times in-memory
        if (generatedPdfs.has(safeId)) return;
        generatedPdfs.add(safeId);

        const filename = `reservation_${safeId}.pdf`;
        const filePath = path.join(pdfsDir, filename);

        const stream = fs.createWriteStream(filePath);
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        doc.pipe(stream);

        doc.fontSize(20).text('GSM Transport', { align: 'center' });
        doc.moveDown();
        doc.fontSize(16).text('Réservation Bagage', { align: 'center' });
        doc.moveDown();

        let matricule = booking.matricule || '';
        if (!matricule && booking.bagage_numero && booking.bagage_numero.includes('/')) matricule = booking.bagage_numero.split('/')[0];
        if (matricule) doc.fontSize(12).text(`Matricule: ${matricule}`);

        doc.fontSize(12).text(`Numéro: ${id}`);
        if (booking.exp_nom || booking.exp_prenom) doc.text(`Expéditeur: ${booking.exp_nom || ''} ${booking.exp_prenom || ''}`);
        if (booking.dest_nom || booking.dest_prenom) doc.text(`Destinataire: ${booking.dest_nom || ''} ${booking.dest_prenom || ''}`);
        if (booking.exp_tel) doc.text(`Téléphone exp: ${booking.exp_tel}`);
        if (booking.dest_tel) doc.text(`Téléphone dest: ${booking.dest_tel}`);
        if (booking.pays_dest || booking.destination) doc.text(`Destination: ${booking.pays_dest || ''} ${booking.destination || ''}`);
        if (booking.nb_bagages) doc.text(`Bagages: ${booking.nb_bagages}`);
        if (booking.poids) doc.text(`Poids: ${booking.poids} kg`);
        if (booking.prix) doc.text(`Prix: ${booking.prix} €`);
        if (booking.notes) { doc.moveDown(); doc.text(`Note: ${booking.notes}`); }

        doc.end();

        stream.on('finish', async () => {
          const pdfLink = `/pdfs/${filename}`;
          const payload = { ...booking, pdfLink, createdAt: booking.createdAt };

          // persist notification JSON fallback
          persistNotification({ ...payload, type: 'booking' });

          // try saving booking to DB if available (ensure payload saved)
          try {
            const mongo2 = getDb();
            if (mongo2) await mongo2.collection('bookings').insertOne(payload);
            else if (adminDb) await adminDb.collection('bookings').add(payload);
          } catch (e) { console.warn('save booking in background failed', e); }

          // emit to connected clients (admin will show it)
          try { io.emit('booking_notification', payload); } catch (e) { console.warn('emit booking_notification failed', e); }
          try { io.emit('pdf_generated', { filename, url: pdfLink }); } catch (e) { /* ignore */ }
        });
      } catch (e) {
        console.warn('post /api/bookings: pdf generation failed', e);
      }
    })();

    res.json({ success: true, source: savedId ? (adminDb ? 'firestore' : 'mongodb') : 'json', id: savedId || null });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// ==============================
// 📄 RE-GÉNÉRER PDF (admin/UI)
// ==============================
// Admin-only endpoint: generate and download PDF for a booking
app.get('/generate-pdf/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    let booking = null;

    // Try MongoDB by bagage_numero or _id
    try {
      const mongo = getDb();
      if (mongo) {
        booking = await mongo.collection('bookings').findOne({ bagage_numero: id }) || null;
        if (!booking) {
          try { booking = await mongo.collection('bookings').findOne({ _id: ObjectId(id) }); } catch(e) { /* ignore invalid ObjectId */ }
        }
      }
    } catch (e) { console.warn('generate-pdf mongo lookup failed', e); }

    // Try Firestore
    if (!booking && adminDb) {
      try {
        const docRef = adminDb.collection('bookings').doc(id);
        const doc = await docRef.get();
        if (doc.exists) booking = { id: doc.id, ...doc.data() };
        else {
          const q = await adminDb.collection('bookings').where('bagage_numero', '==', id).limit(1).get();
          if (!q.empty) booking = { id: q.docs[0].id, ...q.docs[0].data() };
        }
      } catch (e) { console.warn('generate-pdf firestore lookup failed', e); }
    }

    // Fallback JSON file
    if (!booking) {
      const file = path.join(__dirname, 'bookings.json');
      try {
        await fsp.access(file);
        const raw = await fsp.readFile(file, 'utf8');
        const list = JSON.parse(raw || '[]');
        booking = list.find(b => (b && (b.bagage_numero === id || (b.id && String(b.id) === String(id)))));
      } catch (e) { /* no bookings file */ }
    }

    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const filename = `reservation_${booking.bagage_numero || booking.id || id}.pdf`;
    const filePath = path.join(pdfsDir, filename);

    const stream = fs.createWriteStream(filePath);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(stream);

    doc.fontSize(20).text('GSM Transport', { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).text('Réservation Bagage', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Numéro: ${booking.bagage_numero || booking.id || id}`);
    if (booking.exp_nom || booking.exp_prenom) doc.text(`Expéditeur: ${booking.exp_nom || ''} ${booking.exp_prenom || ''}`);
    if (booking.dest_nom || booking.dest_prenom) doc.text(`Destinataire: ${booking.dest_nom || ''} ${booking.dest_prenom || ''}`);
    if (booking.exp_tel) doc.text(`Téléphone exp: ${booking.exp_tel}`);
    if (booking.dest_tel) doc.text(`Téléphone dest: ${booking.dest_tel}`);
    if (booking.pays_dest || booking.destination) doc.text(`Destination: ${booking.pays_dest || ''} ${booking.destination || ''}`);
    if (booking.nb_bagages) doc.text(`Bagages: ${booking.nb_bagages}`);
    if (booking.poids) doc.text(`Poids: ${booking.poids} kg`);
    if (booking.prix) doc.text(`Prix: ${booking.prix} €`);
    if (booking.notes) { doc.moveDown(); doc.text(`Note: ${booking.notes}`); }

    doc.end();

    stream.on('finish', async () => {
      try {
        const pdfLink = `/pdfs/${filename}`;

        // Persist a lightweight notification for admin UIs
        try { persistNotification({ ...booking, pdfLink, type: 'pdf_regen', createdAt: new Date().toISOString() }); } catch (e) { console.warn('persistNotification failed', e); }

        // Emit realtime event so admin panels refresh
        try { io.emit('pdf_generated', { filename, url: pdfLink }); } catch (e) { console.warn('emit pdf_generated failed', e); }

        // Send file to client for immediate download
        return res.download(filePath, filename, (err) => {
          if (err) {
            console.error('res.download error', err);
            try { if (!res.headersSent) res.status(500).end(); } catch (e) { /* ignore */ }
          }
        });
      } catch (err) {
        console.error('generate-pdf finish error', err);
        if (!res.headersSent) return res.status(500).json({ error: err.message });
      }
    });

    stream.on('error', (err) => {
      console.error('generate-pdf stream error', err);
      if (!res.headersSent) return res.status(500).json({ error: err.message });
    });

  } catch (err) {
    console.error('generate-pdf error', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});
