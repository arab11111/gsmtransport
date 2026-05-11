const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const PDFDocument = require('pdfkit');
// Optional MongoDB integration (use MONGODB_URI env var)
const { MongoClient, ServerApiVersion } = require('mongodb');
let mongoClient = null;
let usersCollection = null;
// initialize Mongo asynchronously if MONGODB_URI provided (users collection only)
(async function initMongo() {
  try {
    const uri = process.env.MONGODB_URI || null;
    if (!uri) { console.log('MONGODB_URI not set, skipping MongoDB init'); return; }
    // Use explicit `client` variable as requested, but keep `mongoClient` reference for compatibility
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      }
    });
    mongoClient = client;
    await client.connect();
    const db = process.env.MONGODB_DB ? client.db(process.env.MONGODB_DB) : client.db();
    usersCollection = db.collection('users');
    try { await usersCollection.createIndex({ matricule: 1 }, { unique: true }); } catch (e) {}
    try { await usersCollection.createIndex({ whatsapp: 1 }); } catch (e) {}
    console.log('Connected to MongoDB (users only)');
  } catch (e) { console.warn('MongoDB init failed', e); }
})();
// Optional Google Drive integration
let driveClient = null;
try {
  const { google } = require('googleapis');
  const DRIVE_CRED_FILE = path.join(__dirname, 'drive_credentials.json'); // OAuth2 client credentials
  const DRIVE_TOKEN_FILE = path.join(__dirname, 'drive_token.json'); // OAuth2 token for gsmauto15@gmail.com

  async function initDriveClient() {
    try {
      const credRaw = await fsp.readFile(DRIVE_CRED_FILE, 'utf8').catch(() => null);
      const tokenRaw = await fsp.readFile(DRIVE_TOKEN_FILE, 'utf8').catch(() => null);
      if (!credRaw || !tokenRaw) return null;
      const creds = JSON.parse(credRaw);
      const token = JSON.parse(tokenRaw);
      const clientData = creds.installed || creds.web || creds;
      const oAuth2Client = new google.auth.OAuth2(clientData.client_id, clientData.client_secret, (clientData.redirect_uris && clientData.redirect_uris[0]) || 'urn:ietf:wg:oauth:2.0:oob');
      oAuth2Client.setCredentials(token);
      const drive = google.drive({ version: 'v3', auth: oAuth2Client });
      return drive;
    } catch (e) { console.warn('initDriveClient failed', e); return null; }
  }

  // initialize asynchronously but non-blocking
  initDriveClient().then(d => { driveClient = d; if (driveClient) console.log('Google Drive client initialized'); }).catch(() => {});
} catch (e) { console.warn('googleapis not available', e); }

// Upload or update users.json to the authenticated Google Drive account
async function uploadUsersToDrive(users) {
  try {
    if (!driveClient) return false;
    const filename = 'gsm_users.json';
    // find existing file
    const listRes = await driveClient.files.list({ q: `name='${filename.replace(/'/g,"\\'")}' and trashed=false`, fields: 'files(id,name)' });
    const content = JSON.stringify(users, null, 2);
    if (listRes && listRes.data && Array.isArray(listRes.data.files) && listRes.data.files.length > 0) {
      const fileId = listRes.data.files[0].id;
      await driveClient.files.update({ fileId, requestBody: { name: filename }, media: { mimeType: 'application/json', body: Buffer.from(content) } });
      return true;
    } else {
      await driveClient.files.create({ requestBody: { name: filename, mimeType: 'application/json' }, media: { mimeType: 'application/json', body: Buffer.from(content) } });
      return true;
    }
  } catch (e) { console.warn('uploadUsersToDrive failed', e); return false; }
}

// Firebase Admin / Firestore disabled for this project (we use Firebase Auth on client)
const admin = null;
const adminDb = null;

// Basic helpers
const app = express();
const server = http.createServer(app);
// tighten CORS: allow origins from env or default to production domain
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['https://gsmtransport.onrender.com'];
const io = socketIo(server, { cors: { origin: ALLOWED_ORIGINS, methods: ['GET','POST'] } });

// Require GSM admin code in env to avoid insecure default
const GSM_CODE = process.env.GSM_ADMIN_CODE;
if (!GSM_CODE) {
  console.error('GSM_ADMIN_CODE manquant — définissez la variable d\'environnement GSM_ADMIN_CODE');
  process.exit(1);
}

const PDFS_DIR = path.join(__dirname, 'pdfs');
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');
const NOTIF_FILE = path.join(__dirname, 'notifications.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// Ensure directories exist
(async () => { try { await fsp.mkdir(PDFS_DIR, { recursive: true }); } catch (e) {} })();
// ensure user photos directory exists
// photos removed: no user_photos directory needed

// In-memory dedupe for PDF generation
const generatedPdfs = new Set();

// limit JSON body to 5MB to mitigate large base64 uploads
app.use(express.json({ limit: '5mb' }));
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
  const matricule = booking.matricule || '';
  const safeMat = matricule ? sanitize(matricule) + '_' : '';
  const safeKey = `${safeMat}${safeId}`;
  const filename = `reservation_${safeKey}.pdf`;
  const urlPath = `/pdfs/${filename}`;

  if (generatedPdfs.has(safeKey)) return urlPath;
  generatedPdfs.add(safeKey);

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

// photo endpoints removed — photos are no longer collected or served

// Return all users (from local JSON fallback or Firestore)
app.get('/api/users', async (req, res) => {
  try {
    // Prefer MongoDB if configured
    if (usersCollection) {
      try {
        const docs = await usersCollection.find({}).sort({ createdAt: -1 }).limit(1000).toArray();
        return res.json(docs || []);
      } catch (e) { console.warn('mongo /api/users failed', e); }
    }
    let list = await readJson(USERS_FILE, []);
    // Firestore disabled — using local JSON or MongoDB fallback
    res.json(list || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Find single user by matricule or phone (param may be matricule or phone)
app.get('/api/users/:key', async (req, res) => {
  try {
    const key = (req.params.key || '').toString();
    if (!key) return res.status(400).json({ error: 'Missing key' });
    const norm = key.replace(/[^+0-9]/g,'');
    // try MongoDB first
    if (usersCollection) {
      try {
        const byMat = await usersCollection.findOne({ matricule: key });
        if (byMat) return res.json({ source: 'mongo', user: byMat });
        const byPhone = await usersCollection.findOne({ whatsapp: norm });
        if (byPhone) return res.json({ source: 'mongo', user: byPhone });
      } catch (e) { console.warn('mongo /api/users/:key failed', e); }
    }

    let list = await readJson(USERS_FILE, []);
    // Firestore disabled — fallback to local JSON or MongoDB lookup above

    // fallback to local JSON
    let found = list.find(u => u && ((u.matricule && u.matricule.toString().toLowerCase() === key.toLowerCase()) || ((u.whatsapp||'').toString().replace(/[^+0-9]/g,'') === norm) || (u.id && String(u.id) === key)));
    if (!found) return res.status(404).json({ error: 'User not found' });
    res.json({ source: 'json', user: found });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notifications', async (req, res) => {
  try {
    // Firestore disabled — use local JSON fallback
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

// Verify GSM admin code (server-side) to avoid exposing the code in client sources
app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const code = req.body && req.body.code ? String(req.body.code).trim() : '';
    if (!code) return res.status(400).json({ error: 'missing_code' });
    if (code === GSM_CODE) return res.json({ success: true });
    return res.status(403).json({ success: false });
  } catch (e) { return res.status(500).json({ error: e.message }); }
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
    // normalize phone helper
    const normalizePhone = p => (p || '').toString().replace(/[^+0-9]/g, '');
    // simple validation for exp_tel (WhatsApp-like: + and 7-15 digits)
    const exp_tel = normalizePhone(data.exp_tel || data.whatsapp || '');
    if (!/^[+]?[0-9]{7,15}$/.test(exp_tel)) return res.status(400).json({ error: 'Numéro WhatsApp/téléphone invalide. Utiliser le format international, ex: +33123456789' });

    // attach normalized phone back
    data.exp_tel = exp_tel;

    // attach matricule from users.json if not provided but exp_tel matches a registered user
    try {
      // prefer Mongo lookup
      if (usersCollection) {
        try {
          const found = await usersCollection.findOne({ whatsapp: exp_tel });
          if (found && !data.matricule) data.matricule = found.matricule;
        } catch (e) { /* ignore mongo lookup */ }
      } else {
        const users = await readJson(USERS_FILE, []);
        const found = users.find(u => u && (u.whatsapp || '').replace(/[^+0-9]/g,'') === exp_tel);
        if (found && !data.matricule) data.matricule = found.matricule;
      }
    } catch (e) { /* ignore */ }

    // prevent duplicate bookings from same contact within 24 hours
    try {
      const listExisting = await readJson(BOOKINGS_FILE, []);
      const cutoff = Date.now() - (24 * 60 * 60 * 1000);
      const dup = listExisting.find(b => b && ((b.exp_tel||'').toString().replace(/[^+0-9]/g,'') === exp_tel) && (new Date(b.createdAt || 0).getTime() > cutoff));
      if (dup) return res.status(409).json({ error: 'Une réservation existe déjà pour ce numéro dans les dernières 24 heures.' });
    } catch (e) { /* ignore */ }

    const booking = { ...data, createdAt: new Date().toISOString() };

    // persist bookings to local JSON (bookings/PDFs are not stored in MongoDB)
    let savedId = null;
    try {
      const list = await readJson(BOOKINGS_FILE, []);
      list.unshift(booking);
      await writeJson(BOOKINGS_FILE, list);
    } catch (e) { console.warn('persist booking failed', e); }

    // Firestore disabled — bookings persisted to local JSON (or MongoDB if configured)

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

// Simple registration endpoint: server generates a matricule and stores basic user info
app.post('/api/register', async (req, res) => {
  try {
    // accept additional fields: pays_residence, adresse_france, adresse_algerie, id_number
    const { nom, prenom, whatsapp, pays_residence, adresse_france, adresse_algerie, id_number } = req.body || {};
    if (!nom || !prenom || !whatsapp || !pays_residence || !id_number) return res.status(400).json({ error: 'Missing required fields: nom, prenom, pays_residence, id_number, whatsapp' });
    // country-specific address validation
    if (pays_residence === 'France' && !(req.body.adresse_france && req.body.adresse_france.toString().trim())) return res.status(400).json({ error: 'Adresse en France requise pour les résidents France' });
    if (pays_residence === 'Algérie' && !(req.body.adresse_algerie && req.body.adresse_algerie.toString().trim())) return res.status(400).json({ error: 'Adresse en Algérie requise pour les résidents Algérie' });
    // photos are no longer required or accepted

    // normalize whatsapp format
    const normalizePhone = p => (p || '').toString().replace(/[^+0-9]/g, '');
    const norm = normalizePhone(whatsapp);
    if (!/^[+]?[0-9]{7,15}$/.test(norm)) return res.status(400).json({ error: 'Format WhatsApp invalide. Utilisez le format international, ex: +33123456789' });

    // check existing by whatsapp in Mongo or JSON
    try {
      if (usersCollection) {
        const existing = await usersCollection.findOne({ whatsapp: norm });
        if (existing) return res.json({ success: true, matricule: existing.matricule, existing: true });
      } else {
        const list = await readJson(USERS_FILE, []);
        const existing = list.find(u => u && ((u.whatsapp||'').toString().replace(/[^+0-9]/g,'') === norm));
        if (existing) return res.json({ success: true, matricule: existing.matricule, existing: true });
      }
    } catch (e) { /* ignore */ }

    const matricule = `GSM-${new Date().getFullYear()}-${Math.floor(100000 + Math.random()*900000)}`;
    // mask ID number for privacy before persisting
    const maskedId = id_number ? (String(id_number).slice(0,2) + '****') : '';
    const user = {
      id: Date.now(), matricule, nom, prenom, whatsapp: norm,
      pays_residence: pays_residence || '', adresse_france: adresse_france || '', adresse_algerie: adresse_algerie || '',
      id_number_masked: maskedId, createdAt: new Date().toISOString()
    };

    // no photo handling

    // persist: prefer MongoDB, fallback to JSON; also try Firestore
    try {
      if (usersCollection) {
        try {
          await usersCollection.insertOne(user);
          // sync local JSON snapshot (best-effort)
          try { const all = await usersCollection.find({}).sort({ createdAt: -1 }).limit(2000).toArray(); await writeJson(USERS_FILE, all); } catch (e) {}
        } catch (e) { console.warn('mongo insert user failed', e); }
      } else {
        const list = await readJson(USERS_FILE, []);
        list.unshift(user);
        await writeJson(USERS_FILE, list);
        try { await uploadUsersToDrive(list); } catch (e) { console.warn('uploadUsersToDrive error', e); }
      }
    } catch (e) { console.warn('failed to persist user', e); }

    // Firestore disabled — not persisting to Firestore in this project

    res.json({ success: true, matricule });
  } catch (e) {
    console.error('/api/register error', e);
    res.status(500).json({ error: e.message });
  }
});

// Admin endpoint to regenerate and download PDF
app.get('/generate-pdf/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // look in JSON fallback (bookings are stored in local JSON / Firestore)
    let booking = null;
    const list = await readJson(BOOKINGS_FILE, []);
    booking = list.find(b => (b && (b.bagage_numero === id || String(b.id) === String(id))));
    // Firestore disabled — booking lookup only uses local JSON or MongoDB

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
