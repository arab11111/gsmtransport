const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const app = express();
const server = http.createServer(app);

// ✅ socket.io (compatible Render)
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ✅ Mode JSON local (pas de Firebase)
const adminDb = null;
console.log('⚠️ Mode JSON local activé');

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
io.on('connection', (socket) => {
  console.log('Client connecté:', socket.id);

  // 🔔 envoyer anciennes notifications
  try {
    const notifFile = path.join(__dirname, 'notifications.json');
    if (fs.existsSync(notifFile)) {
      const list = JSON.parse(fs.readFileSync(notifFile, 'utf8') || '[]');
      if (list.length) socket.emit('pending_notifications', list);
    }
  } catch (e) {}

  // =====================
  // 📦 NOUVELLE RESERVATION
  // =====================
  socket.on('new_booking', (data) => {
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
      doc.text(`Téléphone exp: ${data.exp_tel}`);
      doc.text(`Téléphone dest: ${data.dest_tel}`);
      doc.text(`Destination: ${data.pays_dest} / ${data.destination}`);
      doc.text(`Bagages: ${data.nb_bagages}`);
      doc.text(`Poids: ${data.poids} kg`);
      doc.text(`Prix: ${data.prix} €`);

      if (data.notes) {
        doc.moveDown();
        doc.text(`Note: ${data.notes}`);
      }

      doc.end();

      stream.on('finish', () => {
        const pdfLink = `/pdfs/${filename}`;

        const payload = {
          ...data,
          pdfLink,
          date: new Date().toISOString()
        };

        io.emit('booking_notification', payload);
        persistNotification({ ...payload, type: 'booking' });

        io.emit('pdf_generated', {
          filename,
          url: pdfLink
        });
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
app.post('/api/settings', (req, res) => {
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


// ==============================
// 🚀 START SERVER
// ==============================
const PORT = process.env.PORT || 3002;

server.listen(PORT, () => {
  console.log('Serveur lancé sur port', PORT);
});
