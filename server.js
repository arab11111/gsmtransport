const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
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

// Mongo
const mongoLib = tryRequireLib('mongo') || {};
const initMongo = mongoLib.initMongo || (async () => null);
const getDb = mongoLib.getDb || (() => null);
const ObjectId = mongoLib.ObjectId || null;

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
    // ✅ MongoDB primary
    const mongo = getDb();
    if (mongo) {
      await mongo.collection('notifications').insertOne(payload);
      console.log('✅ Notification sauvegardée MongoDB');
    } else if (adminDb) {
      // Firestore fallback if configured
      await adminDb.collection('notifications').add(payload);
      console.log('✅ Notification sauvegardée Firestore');
    }

    // ✅ fallback JSON (always keep JSON persistence)
    persistNotification(payload);

  } catch (error) {
    console.error('❌ Erreur saveNotification:', error);
  }
}

// 📁 dossier PDF
const pdfsDir = path.join(__dirname, 'pdfs');
if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir);

// 📁 middlewares
app.use('/pdfs', express.static(pdfsDir));
app.use(express.static(path.join(__dirname)));
app.use(express.json());


// ==============================
// 🔔 Notifications JSON
// ==============================
function persistNotification(obj){
  try{
    const file = path.join(__dirname, 'notifications.json');
    let arr = [];

    if (fs.existsSync(file)){
      try{
        arr = JSON.parse(fs.readFileSync(file,'utf8')||'[]');
      }catch(e){
        arr = [];
      }
    }

    arr.unshift({
      ...obj,
      receivedAt: new Date().toISOString(),
      read: false
    });

    if (arr.length > 200) arr = arr.slice(0,200);

    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
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
app.post('/upload-pdf', (req, res) => {
  const filename = req.query.filename || `file_${Date.now()}.pdf`;
  const filePath = path.join(pdfsDir, path.basename(filename));

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));

  req.on('end', () => {
    fs.writeFileSync(filePath, Buffer.concat(chunks));

    res.json({
      success: true,
      url: `/pdfs/${path.basename(filename)}`
    });

    io.emit('pdf_generated', {
      filename: path.basename(filename),
      url: `/pdfs/${path.basename(filename)}`
    });
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
    if (fs.existsSync(notifFile)) {
      const list = JSON.parse(fs.readFileSync(notifFile, 'utf8') || '[]');
      if (list.length) socket.emit('pending_notifications', list);
    }
  } catch (e) {}

  // 🔥 Charger anciennes réservations Firestore si disponible (envoi au client connecté)
  try {
    const mongo = getDb();
    if (mongo) {
      const list = await mongo
        .collection('bookings')
        .find()
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();

      if (list.length) socket.emit('pending_notifications', list);
    } else if (adminDb) {
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
        const filename = `reservation_${data.bagage_numero}.pdf`;
        const filePath = path.join(pdfsDir, filename);
        const stream = fs.createWriteStream(filePath);
        const doc = new PDFDocument({ size: 'A4', margin: 40 });

        doc.pipe(stream);

        doc.fontSize(18).text('Réservation Bagage', { align: 'center' });
        doc.moveDown();

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

  async function saveNotificationWithPDF(data) {
    const pdfLink = await generatePDF(data);

    const payload = {
      ...data,
      pdfLink,
      read: false,
      createdAt: new Date().toISOString()
    };

    // use unified saveNotification (Firestore + JSON fallback)
    await saveNotification(payload);

    return payload;
  }

  socket.on('new_booking', async (data) => {
    console.log('Nouvelle réservation:', data);

    try {
      const filename = `reservation_${data.bagage_numero}.pdf`;
      const filePath = path.join(pdfsDir, filename);

      const stream = fs.createWriteStream(filePath);
      const doc = new PDFDocument({ size: 'A4', margin: 40 });

      doc.pipe(stream);

      doc.fontSize(18).text('Réservation Bagage', { align: 'center' });
      doc.moveDown();

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

      stream.on('finish', async () => {
        const pdfLink = `/pdfs/${filename}`;

        const payload = {
          ...data,
          pdfLink,
          createdAt: new Date().toISOString()
        };

        // 🔥 SAVE FIRESTORE as booking
        try {
          const mongo = getDb();
          if (mongo) {
            await mongo.collection('bookings').insertOne(payload);
          } else if (adminDb) {
            await adminDb.collection('bookings').add(payload);
          }
        } catch (e) { console.warn('save booking failed', e); }

        // 📁 fallback JSON notif
        persistNotification({ ...payload, type: 'booking' });

        // 🔔 envoyer à tous les clients
        io.emit('booking_notification', payload);

        io.emit('pdf_generated', { filename, url: pdfLink });
      });

    } catch (err) {
      console.error('Erreur PDF:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté:', socket.id);
  });
});


// ==============================
// ⚙️ SETTINGS (DATE + NOTE)
// ==============================

// GET
app.get('/api/settings', (req, res) => {
  try {
    const file = path.join(__dirname, 'settings.json');

    if (fs.existsSync(file)) {
      return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    }

    res.json({ note: '', selectedDate: null });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST
app.post('/api/settings', verifyFirebaseToken, requireAdmin, (req, res) => {
  try {
    const { note, selectedDate } = req.body;

    const file = path.join(__dirname, 'settings.json');

    let cur = {};
    if (fs.existsSync(file)) {
      try {
        cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
    }

    const next = {
      ...cur,
      ...(note !== undefined ? { note } : {}),
      ...(selectedDate !== undefined ? { selectedDate } : {})
    };

    fs.writeFileSync(file, JSON.stringify(next, null, 2));

    io.emit('settings_updated', next);

    res.json({ success: true, settings: next });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auth check endpoint: verifies token and returns isAdmin flag
app.get('/api/auth/check', verifyFirebaseToken, (req, res) => {
  try {
    const isAdmin = isAdminEmail(req.user && req.user.email);
    res.json({ isAdmin: !!isAdmin, user: req.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// load modular route handlers
try {
  require('./note')(app, io);
} catch (e) { console.warn('Could not load note module', e); }

try {
  require('./date')(app, io);
} catch (e) { console.warn('Could not load date module', e); }

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

    if (fs.existsSync(file)) {
      const list = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
      return res.json(list);
    }

    res.json([]);

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
    if (mongo) {
      const r = await mongo.collection('bookings').insertOne(booking);
      return res.json({ success: true, id: (r.insertedId || '').toString(), source: 'mongodb' });
    }

    // 🔥 FIRESTORE
    if (adminDb) {
      const ref = await adminDb.collection('bookings').add(booking);
      return res.json({ success: true, id: ref.id, source: 'firestore' });
    }

    // 📁 FALLBACK JSON
    const file = path.join(__dirname, 'bookings.json');
    let list = [];

    if (fs.existsSync(file)) {
      list = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
    }

    list.unshift(booking);
    fs.writeFileSync(file, JSON.stringify(list, null, 2));

    res.json({ success: true, source: 'json' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
