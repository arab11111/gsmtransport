const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const PDFDocument = require('pdfkit');

// Optional Firebase Admin (if provided in the project)
let admin = null;
let adminDb = null;
try {
  admin = require('firebase-admin');
  try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    adminDb = admin.firestore();
    console.log('Firebase Admin initialisé');
  } catch (e) {
    try { admin.initializeApp(); adminDb = admin.firestore(); console.log('Firebase Admin initialisé via ADC'); } catch (e2) {}
  }
} catch (e) {
  // firebase-admin not installed — fine, fallback to JSON
}

// Basic helpers
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET','POST'] } });

const PDFS_DIR = path.join(__dirname, 'pdfs');
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');
const NOTIF_FILE = path.join(__dirname, 'notifications.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// Ensure directories exist
(async () => { try { await fsp.mkdir(PDFS_DIR, { recursive: true }); } catch (e) {} })();

// In-memory dedupe for PDF generation
const generatedPdfs = new Set();

app.use(express.json());
app.use('/pdfs', express.static(PDFS_DIR));
app.use(express.static(path.join(__dirname)));

// Small JSON helpers
async function readJson(filePath, fallback) {
  try { await fsp.access(filePath); const raw = await fsp.readFile(filePath, 'utf8'); return JSON.parse(raw || '[]'); } catch (e) { return fallback; }
}
async function writeJson(filePath, data) { try { await fsp.writeFile(filePath, JSON.stringify(data, null, 2)); } catch (e) { console.warn('writeJson failed', filePath, e); } }

async function persistNotification(payload) {
  try {
    const list = await readJson(NOTIF_FILE, []);
    list.unshift({ ...payload, receivedAt: new Date().toISOString(), read: false });
    if (list.length > 200) list.length = 200;
    await writeJson(NOTIF_FILE, list);
  } catch (e) { console.warn('persistNotification error', e); }
}

// Centralized PDF generator — returns URL path
async function generatePdfForBooking(booking) {
  const sanitize = s => (s || '').toString().replace(/[^a-zA-Z0-9-_.]/g, '_');
  const id = booking.bagage_numero || booking.id || Date.now();
  const safeId = sanitize(id);
  const filename = `reservation_${safeId}.pdf`;
  const urlPath = `/pdfs/${filename}`;

  if (generatedPdfs.has(safeId)) return urlPath;
  generatedPdfs.add(safeId);

  const filePath = path.join(PDFS_DIR, filename);
  await new Promise((resolve, reject) => {
    try {
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

      stream.on('finish', resolve);
      stream.on('error', reject);
    } catch (err) { reject(err); }
  });

  try { io.emit('pdf_generated', { filename, url: urlPath }); } catch (e) {}
  return urlPath;
}

// ROUTES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/notifications', async (req, res) => {
  try {
    if (adminDb) {
      const snapshot = await adminDb.collection('notifications').orderBy('createdAt','desc').limit(50).get();
      const list = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json(list);
    }
    const list = await readJson(NOTIF_FILE, []);
    return res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { note } = req.body || {};
    const provided = req.body && req.body.selectedDate;
    const selectedDate = provided || new Date().toISOString().slice(0,10);
    let cur = await readJson(SETTINGS_FILE, {});
    cur = { ...cur, ...(note !== undefined ? { note } : {}), selectedDate };
    await writeJson(SETTINGS_FILE, cur);
    try { io.emit('settings_updated', cur); } catch (e) {}
    res.json(cur);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings', async (req, res) => {
  try { const s = await readJson(SETTINGS_FILE, {}); res.json(s); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload a PDF (used by clients who generate locally)
app.post('/upload-pdf', async (req, res) => {
  const filename = req.query.filename || `file_${Date.now()}.pdf`;
  const filePath = path.join(PDFS_DIR, path.basename(filename));
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      await fsp.writeFile(filePath, Buffer.concat(chunks));
      const basename = path.basename(filename);
      // emit once per safe id
      const safeId = basename.replace(/^reservation_/, '').replace(/\.pdf$/i, '');
      if (!generatedPdfs.has(safeId)) {
        generatedPdfs.add(safeId);
        io.emit('pdf_generated', { filename: basename, url: `/pdfs/${basename}` });
      }
      res.json({ success: true, url: `/pdfs/${basename}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// Save booking — server generates PDF ONCE, emits notification and returns pdf link
app.post('/api/bookings', async (req, res) => {
  try {
    const data = req.body || {};
    const booking = { ...data, createdAt: new Date().toISOString() };

    // persist in JSON fallback
    const list = await readJson(BOOKINGS_FILE, []);
    list.unshift(booking);
    await writeJson(BOOKINGS_FILE, list);

    // try saving to Firestore if available
    let savedId = null;
    try { if (adminDb) { const ref = await adminDb.collection('bookings').add(booking); savedId = ref.id; } } catch (e) { console.warn('firestore add failed', e); }

    // Generate PDF once (await)
    let pdfLink = null;
    try { pdfLink = await generatePdfForBooking(booking); } catch (e) { console.warn('generatePdfForBooking failed', e); }

    const payload = { ...booking, pdfLink };
    try { persistNotification({ ...payload, type: 'booking' }); } catch (e) {}

    // emit single booking_notification
    try { io.emit('booking_notification', payload); } catch (e) { console.warn('emit booking_notification failed', e); }

    res.json({ success: true, id: savedId, pdf: pdfLink });
  } catch (e) { console.error('POST /api/bookings', e); res.status(500).json({ error: e.message }); }
});

// Admin endpoint to regenerate and download PDF
app.get('/generate-pdf/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // look in JSON fallback first
    const list = await readJson(BOOKINGS_FILE, []);
    let booking = list.find(b => (b && (b.bagage_numero === id || String(b.id) === String(id))));
    // try Firestore
    if (!booking && adminDb) {
      try {
        const doc = await adminDb.collection('bookings').doc(id).get();
        if (doc.exists) booking = { id: doc.id, ...doc.data() };
        else {
          const q = await adminDb.collection('bookings').where('bagage_numero','==',id).limit(1).get();
          if (!q.empty) booking = { id: q.docs[0].id, ...q.docs[0].data() };
        }
      } catch (e) { console.warn('firestore lookup failed', e); }
    }

    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const pdfLink = await generatePdfForBooking(booking);
    const filename = path.basename(pdfLink);
    const filePath = path.join(PDFS_DIR, filename);
    return res.download(filePath, filename);
  } catch (e) { console.error('generate-pdf error', e); res.status(500).json({ error: e.message }); }
});

// SOCKET.IO
io.on('connection', async (socket) => {
  console.log('Socket connected', socket.id);

  // send pending notifications (JSON fallback)
  try { const list = await readJson(NOTIF_FILE, []); if (list && list.length) socket.emit('pending_notifications', list); } catch (e) {}

  // clients may emit lightweight client_booking (server will not generate PDF from socket)
  socket.on('client_booking', async (data) => {
    try {
      const payload = { ...(data||{}), createdAt: new Date().toISOString(), read: false };
      persistNotification({ ...payload, type: 'booking' });
      io.emit('booking_notification', payload);
    } catch (e) { console.warn('client_booking error', e); }
  });

  socket.on('disconnect', () => console.log('Socket disconnected', socket.id));
});

// Start
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => console.log('Server started on', PORT));
