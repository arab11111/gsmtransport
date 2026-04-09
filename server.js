const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const adminSdk = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  // fallback to puppeteer if available
  puppeteer = require('puppeteer');
}

// Dossier pour stocker les PDF générés (à servir en statique)
const pdfsDir = path.join(__dirname, 'pdfs');
if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir);
app.use('/pdfs', express.static(pdfsDir));

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname)));
// parse JSON bodies
app.use(express.json());

// Initialize Firebase Admin SDK for server-side Firestore updates
try {
  if (process.env.SERVICE_ACCOUNT_JSON) {
    // SERVICE_ACCOUNT_JSON contains the JSON content of the service account
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    adminSdk.initializeApp({ credential: adminSdk.credential.cert(serviceAccount) });
  } else if (process.env.SERVICE_ACCOUNT_PATH) {
    const serviceAccount = require(process.env.SERVICE_ACCOUNT_PATH);
    adminSdk.initializeApp({ credential: adminSdk.credential.cert(serviceAccount) });
  } else {
    adminSdk.initializeApp(); // use ADC or environment-provided credentials
  }
} catch (e) {
  console.warn('firebase-admin initialization warning:', e.message || e);
}
const adminDb = adminSdk.firestore ? adminSdk.firestore() : null;

// Route par défaut
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint pour recevoir les PDF générés et les stocker dans /pdfs
app.post('/upload-pdf', (req, res) => {
  const filename = req.query.filename || `file_${Date.now()}.pdf`;
  const filePath = path.join(pdfsDir, path.basename(filename));
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    fs.writeFileSync(filePath, Buffer.concat(chunks));
    res.status(200).json({ success: true, url: `/pdfs/${path.basename(filename)}` });
    // Émettre la notification à tous les clients après upload du PDF
    io.emit('pdf_generated', {
      filename: path.basename(filename),
      url: `/pdfs/${path.basename(filename)}`,
      message: `PDF généré : <a href=\"/pdfs/${path.basename(filename)}\" target=\"_blank\" style=\"color:#fff;text-decoration:underline;\">Télécharger le PDF</a>`
    });
  });
});

// Gestion des connexions Socket.IO
io.on('connection', (socket) => {
  console.log('Un client s\'est connecté:', socket.id);

  // Écouter les nouvelles réservations depuis gsmexpress
  socket.on('new_booking', (bookingData) => {
    console.log('Nouvelle réservation reçue:', bookingData);
    // Générer le PDF côté serveur et l'enregistrer dans /pdfs
    try {
      const filename = `reservation_${bookingData.bagage_numero}.pdf`;
      const filePath = path.join(pdfsDir, filename);
      const stream = fs.createWriteStream(filePath);
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      doc.pipe(stream);

      doc.fontSize(18).text('Réservation Bagage', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Numéro: ${bookingData.bagage_numero}`);
      doc.text(`Expéditeur: ${bookingData.exp_nom} ${bookingData.exp_prenom}`);
      doc.text(`Destinataire: ${bookingData.dest_nom} ${bookingData.dest_prenom}`);
      doc.text(`Téléphone exp: ${bookingData.exp_tel}`);
      doc.text(`Téléphone dest: ${bookingData.dest_tel}`);
      doc.text(`Pays / Destination: ${bookingData.pays_dest} / ${bookingData.destination}${bookingData.region ? ' / ' + bookingData.region : ''}`);
      doc.text(`Bagages: ${bookingData.nb_bagages} | Poids: ${bookingData.poids} kg | Prix: ${bookingData.prix} €`);
      if (bookingData.notes) doc.moveDown().fontSize(11).text(`Note: ${bookingData.notes}`);
      doc.end();

      stream.on('finish', () => {
        const pdfLink = `/pdfs/${filename}`;
        // Émettre la notification à tous les clients (admin inclus) avec lien réel
        io.emit('booking_notification', Object.assign({}, bookingData, { pdfLink, date: new Date().toISOString() }));
        // Optionnel : émettre un événement séparé pour PDF généré
        io.emit('pdf_generated', { filename, url: pdfLink });
      });

      stream.on('error', (err) => {
        console.error('Erreur écriture PDF:', err);
        // Fallback: émettre la réservation sans pdfLink
        io.emit('booking_notification', Object.assign({}, bookingData, { date: new Date().toISOString() }));
      });

    } catch (err) {
      console.error('Erreur génération PDF serveur:', err);
      io.emit('booking_notification', Object.assign({}, bookingData, { date: new Date().toISOString() }));
    }
  });

  // Écouter les notifications cloche
  socket.on('bell_notification', (notifData) => {
    console.log('Notification cloche reçue:', notifData);
    io.emit('bell_notification', notifData);
  });

  // Écouter les nouvelles entrées bagages depuis bagages.html
  socket.on('new_luggage', (luggageData) => {
    console.log('Nouvelle entrée bagage reçue:', luggageData);
    io.emit('luggage_notification', luggageData);
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté:', socket.id);
  });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Accédez à l'application via: http://localhost:${PORT}`);
});

// Générer un PDF côté serveur à partir de la page gsmexpress.html
app.get('/generate-pdf/:id', async (req, res) => {
  const id = req.params.id;
  const filename = `reservation_${id}.pdf`;
  const filePath = path.join(pdfsDir, filename);
  try {
    // Prefer explicit Chrome path via env CHROME_PATH to avoid large Chromium download during npm install
    const defaultChrome = process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/chromium';
    const chromePath = process.env.CHROME_PATH || defaultChrome;
    console.log('Using browser executable:', chromePath);
    const launchOpts = { args: ['--no-sandbox', '--disable-setuid-sandbox'], executablePath: chromePath };
    const browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    const url = `${req.protocol}://${req.get('host')}/public/gsmexpress.html?reservationId=${encodeURIComponent(id)}`;
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.pdf({ path: filePath, format: 'A4' });
    await browser.close();
    io.emit('pdf_generated', { filename, url: `/pdfs/${filename}` });
    res.json({ success: true, url: `/pdfs/${filename}` });
  } catch (err) {
    console.error('Erreur génération PDF:', err);
    res.status(500).json({ error: err.message });
  }
});

// Server endpoint to update departures (batch). Optional admin token required via X-ADMIN-TOKEN.
app.post('/api/departures', async (req, res) => {
  try {
    const token = req.get('X-ADMIN-TOKEN');
    if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN !== token) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // If payload is single date + country -> treat as single update (compat with client)
    const body = req.body || {};
    if (body.date && body.country) {
      const date = body.date;
      const country = String(body.country).toLowerCase();
      if (!['algeria','algérie','algerie','france'].includes(country)) {
        return res.status(400).json({ error: 'Invalid country value' });
      }
      // Persist to Firestore departures_map or local file
      if (adminDb) {
        await adminDb.collection('departures_map').doc(date).set({ country }, { merge: true });
      } else {
        const file = path.join(__dirname, 'departures.json');
        let cur = {};
        if (fs.existsSync(file)) {
          try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cur = {}; }
        }
        cur[date] = country;
        fs.writeFileSync(file, JSON.stringify(cur, null, 2));
      }
      io.emit('departures_updated', { date, country, action: 'set' });
      return res.json({ success: true });
    }

    // Otherwise expect batch update { dates: [...], active: boolean }
    if (!adminDb) return res.status(500).json({ error: 'Admin Firestore not initialized' });
    const { dates, active } = body;
    if (!Array.isArray(dates) || typeof active !== 'boolean') return res.status(400).json({ error: 'Invalid payload' });
    const batch = adminDb.batch();
    dates.forEach(date => {
      const docRef = adminDb.collection('departures').doc(date);
      batch.set(docRef, { active: active }, { merge: true });
    });
    await batch.commit();
    // Emit socket event so clients can react quickly (clients also listen to Firestore realtime)
    io.emit('departures_changed', { dates, active });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error /api/departures', err);
    return res.status(500).json({ error: err.message });
  }
});

// Get current global settings (note, selectedDate)
app.get('/api/settings', async (req, res) => {
  try {
    // Try Firestore first
    if (adminDb) {
      const doc = await adminDb.collection('meta').doc('settings').get();
      if (doc.exists) return res.json(doc.data());
    }

    // Fallback to local file
    const settingsFile = path.join(__dirname, 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const raw = fs.readFileSync(settingsFile, 'utf8');
      return res.json(JSON.parse(raw));
    }

    return res.json({ note: '', selectedDate: null });
  } catch (err) {
    console.error('Error GET /api/settings', err);
    return res.status(500).json({ error: err.message });
  }
});

// Update global settings (admin only). Body: { note?: string, selectedDate?: string }
app.post('/api/settings', async (req, res) => {
  try {
    const token = req.get('X-ADMIN-TOKEN');
    if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN !== token) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { note, selectedDate } = req.body || {};
    if (note === undefined && selectedDate === undefined) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const payload = {};
    if (typeof note === 'string') payload.note = note;
    if (selectedDate !== undefined) payload.selectedDate = selectedDate;

    if (adminDb) {
      await adminDb.collection('meta').doc('settings').set(payload, { merge: true });
    } else {
      const settingsFile = path.join(__dirname, 'settings.json');
      let cur = {};
      if (fs.existsSync(settingsFile)) {
        try { cur = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { cur = {}; }
      }
      const next = Object.assign({}, cur, payload);
      fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
    }

    // Notify connected clients about the change
    io.emit('settings_updated', payload);

    return res.json({ success: true, settings: payload });
  } catch (err) {
    console.error('Error POST /api/settings', err);
    return res.status(500).json({ error: err.message });
  }
});

// -----------------
// Auth endpoints
// -----------------

// Verify Firebase ID token (client sends idToken)
app.post('/auth/verify', async (req, res) => {
  try {
    const idToken = req.body && req.body.idToken;
    if (!idToken) return res.status(400).json({ error: 'Missing idToken' });
    if (!adminSdk || !adminSdk.auth) return res.status(500).json({ error: 'Firebase auth not initialized' });
    const decoded = await adminSdk.auth().verifyIdToken(idToken);
    return res.json({ uid: decoded.uid, decoded });
  } catch (err) {
    console.error('Error /auth/verify', err);
    return res.status(401).json({ error: err.message || 'Invalid token' });
  }
});

// Create a custom token for a given UID (admin-only, protected by X-ADMIN-TOKEN)
app.post('/auth/custom-token', async (req, res) => {
  try {
    const token = req.get('X-ADMIN-TOKEN');
    if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN !== token) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { uid, claims } = req.body || {};
    if (!uid) return res.status(400).json({ error: 'Missing uid' });
    if (!adminSdk || !adminSdk.auth) return res.status(500).json({ error: 'Firebase auth not initialized' });
    const custom = await adminSdk.auth().createCustomToken(uid, claims || {});
    return res.json({ token: custom });
  } catch (err) {
    console.error('Error /auth/custom-token', err);
    return res.status(500).json({ error: err.message });
  }
});

// -----------------
// Bookings CRUD (Firestore)
// -----------------

// Create a booking
app.post('/api/bookings', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!adminDb) return res.status(500).json({ error: 'Admin Firestore not initialized' });
    const ref = await adminDb.collection('bookings').add(Object.assign({}, payload, { createdAt: adminSdk.firestore.FieldValue.serverTimestamp() }));
    const doc = await ref.get();
    return res.json({ id: ref.id, data: doc.data() });
  } catch (err) {
    console.error('Error POST /api/bookings', err);
    return res.status(500).json({ error: err.message });
  }
});

// List recent bookings (limit 100)
app.get('/api/bookings', async (req, res) => {
  try {
    if (!adminDb) return res.status(500).json({ error: 'Admin Firestore not initialized' });
    const snapshot = await adminDb.collection('bookings').orderBy('createdAt', 'desc').limit(100).get();
    const items = snapshot.docs.map(d => Object.assign({ id: d.id }, d.data()));
    return res.json(items);
  } catch (err) {
    console.error('Error GET /api/bookings', err);
    return res.status(500).json({ error: err.message });
  }
});

// Get booking by id
app.get('/api/bookings/:id', async (req, res) => {
  try {
    if (!adminDb) return res.status(500).json({ error: 'Admin Firestore not initialized' });
    const doc = await adminDb.collection('bookings').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    return res.json({ id: doc.id, data: doc.data() });
  } catch (err) {
    console.error('Error GET /api/bookings/:id', err);
    return res.status(500).json({ error: err.message });
  }
});

// --- Lightweight departures API (single-date) ---
// GET  /api/departures          -> [{ date: 'YYYY-MM-DD', country: 'algeria'|'france' }]
// POST /api/departures         -> { date, country }  (create/update)
// DELETE /api/departures/:date -> remove entry
app.get('/api/departures', async (req, res) => {
  try {
    // Try Firestore collection 'departures_map' first
    if (adminDb) {
      const snap = await adminDb.collection('departures_map').get();
      const items = snap.docs.map(d => ({ date: d.id, country: (d.data().country || null) }));
      return res.json(items);
    }

    // Fallback to local JSON file
    const file = path.join(__dirname, 'departures.json');
    if (!fs.existsSync(file)) return res.json([]);
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw || '{}');
    const arr = Object.keys(obj).map(k => ({ date: k, country: obj[k] }));
    return res.json(arr);
  } catch (err) {
    console.error('Error GET /api/departures', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/departures/single', async (req, res) => {
  try {
    const token = req.get('X-ADMIN-TOKEN');
    if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN !== token) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { date, country } = req.body || {};
    if (!date || (country !== 'algeria' && country !== 'france' && country !== 'algérie' && country !== 'algerie')) {
      return res.status(400).json({ error: 'Invalid payload, expected { date, country }' });
    }

    if (adminDb) {
      await adminDb.collection('departures_map').doc(date).set({ country: String(country).toLowerCase() }, { merge: true });
    } else {
      const file = path.join(__dirname, 'departures.json');
      let cur = {};
      if (fs.existsSync(file)) {
        try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cur = {}; }
      }
      cur[date] = String(country).toLowerCase();
      fs.writeFileSync(file, JSON.stringify(cur, null, 2));
    }

    io.emit('departures_updated', { date, country: String(country).toLowerCase(), action: 'set' });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error POST /api/departures (single)', err);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/departures/:date', async (req, res) => {
  try {
    const token = req.get('X-ADMIN-TOKEN');
    if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN !== token) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const date = req.params.date;
    if (!date) return res.status(400).json({ error: 'Missing date parameter' });

    if (adminDb) {
      await adminDb.collection('departures_map').doc(date).delete();
    } else {
      const file = path.join(__dirname, 'departures.json');
      if (fs.existsSync(file)) {
        let cur = {};
        try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cur = {}; }
        if (cur[date]) delete cur[date];
        fs.writeFileSync(file, JSON.stringify(cur, null, 2));
      }
    }

    io.emit('departures_updated', { date, action: 'delete' });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error DELETE /api/departures/:date', err);
    return res.status(500).json({ error: err.message });
  }
});
