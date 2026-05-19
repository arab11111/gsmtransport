const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// Optional dependencies guarded to avoid startup failures
let compression = null;
let morgan = null;
let Bull = null;
let PDFDocument = null;
try { compression = require('compression'); } catch (e) {}
try { morgan = require('morgan'); } catch (e) {}
try { Bull = require('bull'); } catch (e) {}
try { PDFDocument = require('pdfkit'); } catch (e) {}

// Optional MongoDB
let MongoClient = null;
let mongoClient = null;
let notificationsCollection = null;
try { MongoClient = require('mongodb').MongoClient; } catch (e) {}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Config and paths
const PORT = process.env.PORT || 3002;
const REDIS_URL = process.env.REDIS_URL || null;
const MONGODB_URI = process.env.MONGODB_URI || null;
const MONGODB_DB = process.env.MONGODB_DB || null;
const GSM_ADMIN_CODE = process.env.GSM_ADMIN_CODE || 'Salim_Anis_2026';
const PDF_CACHE_TTL_MS = parseInt(process.env.PDF_CACHE_TTL_MS || '3600000', 10);

const ROOT = __dirname;
const PDFS_DIR = path.join(ROOT, 'pdfs');
const NOTIF_FILE = path.join(ROOT, 'notifications.json');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');
const BOOKINGS_FILE = path.join(ROOT, 'bookings.json');
const USERS_FILE = path.join(ROOT, 'users.json');

// Ensure directories exist
(async ()=>{ try{ await fsp.mkdir(PDFS_DIR,{ recursive:true }); }catch(e){} })();

// Apply optional middleware
if (compression) app.use(compression());
if (morgan) app.use(morgan('tiny'));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(ROOT));
app.use('/pdfs', express.static(PDFS_DIR));

// Initialize optional services
let pdfQueue = null;
if (Bull && REDIS_URL) {
  try { pdfQueue = new Bull('pdf-queue', REDIS_URL); } catch (e) { pdfQueue = null; }
}

async function initMongo(){
  if (!MongoClient || !MONGODB_URI) return;
  try {
    mongoClient = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
    await mongoClient.connect();
    const db = MONGODB_DB ? mongoClient.db(MONGODB_DB) : mongoClient.db();
    notificationsCollection = db.collection('notifications');
    await notificationsCollection.createIndex({ createdAt: -1 });
    console.log('Mongo: notifications collection ready');
  } catch (e) { console.warn('Mongo init failed', e); mongoClient = null; }
}
initMongo().catch(()=>{});

// In-memory dedupe map with TTL
const generatedPdfs = new Map();
function rememberPdf(key){
  generatedPdfs.set(key, Date.now());
  setTimeout(()=> generatedPdfs.delete(key), PDF_CACHE_TTL_MS).unref?.();
}

// JSON helpers
async function readJson(filePath, fallback){
  try { const raw = await fsp.readFile(filePath, 'utf8'); return JSON.parse(raw || 'null') || fallback; } catch (e) { return fallback; }
}
async function writeJson(filePath, data){
  try { await fsp.writeFile(filePath, JSON.stringify(data, null, 2)); } catch (e) { console.warn('writeJson failed', filePath, e); }
}

// Persist notification: prefer Mongo, file fallback
async function persistNotification(note){
  const doc = { ...note, createdAt: new Date().toISOString() };
  if (notificationsCollection) {
    try { await notificationsCollection.insertOne(doc); return; } catch (e) { console.warn('mongo insert failed', e); }
  }
  // file fallback
  try {
    const list = await readJson(NOTIF_FILE, []);
    list.unshift(doc);
    if (list.length > 500) list.length = 500;
    await writeJson(NOTIF_FILE, list);
  } catch (e) { console.warn('persistNotification fallback failed', e); }
}

// Simple PDF generator using pdfkit if available; returns relative URL
async function generatePdfForBooking(booking){
  const id = booking.id || booking.bagage_numero || Date.now();
  const key = String(id).replace(/[^a-zA-Z0-9-_]/g,'_');
  if (generatedPdfs.has(key)) return `/pdfs/reservation_${key}.pdf`;
  rememberPdf(key);
  const filename = `reservation_${key}.pdf`;
  const filePath = path.join(PDFS_DIR, filename);
  if (!PDFDocument) {
    // no pdfkit: create a tiny placeholder file
    await fsp.writeFile(filePath, `Reservation ${id}\n${JSON.stringify(booking, null, 2)}`);
    return `/pdfs/${filename}`;
  }
  return await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument();
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
      doc.fontSize(18).text('GSM Transport - Réservation', { align: 'center' });
      doc.moveDown();
      for (const k of Object.keys(booking)) doc.fontSize(10).text(`${k}: ${JSON.stringify(booking[k])}`);
      doc.end();
      stream.on('finish', ()=> resolve(`/pdfs/${filename}`));
      stream.on('error', reject);
    } catch (e) { reject(e); }
  });
}

// Queue worker (if queue present)
if (pdfQueue) {
  try {
    pdfQueue.process(async (job)=>{
      const booking = job.data.booking;
      const url = await generatePdfForBooking(booking);
      io.to('admins').emit('pdf_generated', { url });
      return { url };
    });
  } catch (e) { console.warn('pdfQueue worker failed to start', e); }
}

// API: settings
app.get('/api/settings', async (req, res)=>{
  const s = await readJson(SETTINGS_FILE, {});
  res.json(s);
});
app.post('/api/settings', async (req, res)=>{
  const payload = req.body || {};
  const cur = await readJson(SETTINGS_FILE, {});
  const next = { ...cur, ...payload };
  await writeJson(SETTINGS_FILE, next);
  io.emit('settings_updated', next);
  io.to('admins').emit('admin_notifications', next);
  res.json(next);
});

// API: notifications list
app.get('/api/notifications', async (req, res)=>{
  if (notificationsCollection) {
    try { const docs = await notificationsCollection.find({}).sort({ createdAt:-1 }).limit(200).toArray(); return res.json(docs); } catch (e) { console.warn('mongo read notifications failed', e); }
  }
  const list = await readJson(NOTIF_FILE, []);
  res.json(list);
});

// API: users list / lookup by matricule (prefers MongoDB when available)
app.get('/api/users', async (req, res) => {
  const matricule = req.query.matricule;
  // Try MongoDB if initialized
  if (mongoClient) {
    try {
      const db = MONGODB_DB ? mongoClient.db(MONGODB_DB) : mongoClient.db();
      const usersCol = db.collection('users');
      if (matricule) {
        const doc = await usersCol.findOne({ matricule: String(matricule) });
        return res.json(doc ? [doc] : []);
      }
      const docs = await usersCol.find({}).limit(1000).toArray();
      return res.json(docs || []);
    } catch (e) { console.warn('mongo users query failed', e); }
  }
  // Fallback to local users.json
  try {
    const users = await readJson(USERS_FILE, []);
    if (matricule) {
      const found = users.filter(u => u && u.matricule && String(u.matricule).toLowerCase() === String(matricule).toLowerCase());
      return res.json(found);
    }
    return res.json(users || []);
  } catch (e) {
    console.warn('users lookup failed', e);
    return res.json([]);
  }
});

// API: post booking
app.post('/api/bookings', async (req, res)=>{
  try {
    const booking = { ...(req.body||{}), createdAt: new Date().toISOString() };
    // basic phone normalization
    if (booking.exp_tel) booking.exp_tel = String(booking.exp_tel).replace(/[^+0-9]/g,'');
    const bookings = await readJson(BOOKINGS_FILE, []);
    bookings.unshift(booking);
    await writeJson(BOOKINGS_FILE, bookings);

    // enqueue or generate pdf
    let pdfUrl = null;
    if (pdfQueue) {
      try { await pdfQueue.add({ booking }, { attempts: 3 }); } catch (e) { console.warn('enqueue failed', e); }
    } else {
      try { pdfUrl = await generatePdfForBooking(booking); } catch (e) { console.warn('sync pdf failed', e); }
    }

    // persist and emit
    await persistNotification({ type:'booking', booking, pdf: pdfUrl });
    io.to('admins').emit('booking_notification', { booking, pdf: pdfUrl });
    res.json({ success:true, pdf: pdfUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// upload-pdf: accepts raw body and saves
app.post('/upload-pdf', async (req, res)=>{
  try {
    const name = req.query.filename ? path.basename(req.query.filename) : `upload_${Date.now()}.pdf`;
    const filePath = path.join(PDFS_DIR, name);
    const chunks = [];
    req.on('data', c=>chunks.push(c));
    req.on('end', async ()=>{
      await fsp.writeFile(filePath, Buffer.concat(chunks));
      const key = name.replace(/[^a-z0-9_\-\.]/gi,'_');
      rememberPdf(key);
      io.to('admins').emit('pdf_generated', { url: `/pdfs/${name}` });
      res.json({ success:true, url:`/pdfs/${name}` });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// auth verify code
app.post('/api/auth/verify-code', (req,res)=>{
  const code = (req.body && req.body.code) ? String(req.body.code) : '';
  if (!code) return res.status(400).json({ error:'missing' });
  if (code === GSM_ADMIN_CODE) return res.json({ success: true });
  return res.status(403).json({ success:false });
});

// simple register endpoint (local JSON)
app.post('/api/register', async (req, res)=>{
  const body = req.body || {};
  if (!body.nom || !body.prenom || !body.whatsapp) return res.status(400).json({ error:'missing' });
  const users = await readJson(USERS_FILE, []);
  const norm = String(body.whatsapp).replace(/[^+0-9]/g,'');
  const exist = users.find(u => (u.whatsapp||'') === norm);
  if (exist) return res.json({ success:true, matricule: exist.matricule });
  const matricule = 'GSM' + String(Date.now()).slice(-6);
  const user = { id: Date.now(), matricule, nom: body.nom, prenom: body.prenom, whatsapp: norm, createdAt: new Date().toISOString() };
  users.unshift(user);
  await writeJson(USERS_FILE, users);
  res.json({ success:true, matricule });
});

// generate-pdf (regenerate and download)
app.get('/generate-pdf/:id', async (req,res)=>{
  const id = req.params.id;
  const bookings = await readJson(BOOKINGS_FILE, []);
  const booking = bookings.find(b => String(b.id) === String(id) || String(b.bagage_numero) === String(id));
  if (!booking) return res.status(404).json({ error:'not found' });
  try {
    const url = await generatePdfForBooking(booking);
    const filePath = path.join(ROOT, url);
    return res.download(filePath);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SocketIO: admin room
io.on('connection', socket => {
  socket.data.isAdmin = false;
  socket.on('register_admin', code => {
    if (String(code) === String(GSM_ADMIN_CODE)) {
      socket.data.isAdmin = true;
      socket.join('admins');
      socket.emit('admin_registered', { ok:true });
    } else socket.emit('admin_registered', { ok:false });
  });

  // send pending notifications
  (async ()=>{
    try{
      if (notificationsCollection) {
        const docs = await notificationsCollection.find({}).sort({ createdAt:-1 }).limit(200).toArray();
        if (docs && docs.length) socket.emit('pending_notifications', docs);
      } else {
        const list = await readJson(NOTIF_FILE, []);
        if (list && list.length) socket.emit('pending_notifications', list);
      }
    }catch(e){}
  })();

  socket.on('client_booking', async data => {
    await persistNotification({ type:'booking', booking: data });
    io.to('admins').emit('booking_notification', { booking: data });
  });

  socket.on('disconnect', ()=>{});
});

// Start server
server.listen(PORT, ()=> console.log('Server listening on', PORT));
