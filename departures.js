const path = require('path');
const fs = require('fs');
const { getDb } = require('./mongo');
const admin = require('firebase-admin');
const { verifyFirebaseToken, requireAdmin } = require('./auth');

module.exports = function (app, io) {
  // GET active departures (returns array of date strings)
  app.get('/api/departures', async (req, res) => {
    try {
      const mongo = getDb();
      if (mongo) {
        const docs = await mongo.collection('departures').find({ active: true }).toArray();
        const dates = docs.map(d => d.date).filter(Boolean);
        return res.json(dates);
      }

      if (admin && admin.firestore) {
        const snap = await admin.firestore().collection('departures').where('active','==',true).get();
        const dates = snap.docs.map(d => d.id);
        return res.json(dates);
      }

      const file = path.join(__dirname, '..', 'departures.json');
      if (fs.existsSync(file)) {
        const list = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
        return res.json(list.filter(x => x.active).map(x => x.date));
      }

      return res.json([]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST update departures (admin) — protected by Firebase token + admin email
  app.post('/api/departures', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
      const { dates, active } = req.body || {};
      if (!Array.isArray(dates)) return res.status(400).json({ error: 'dates array required' });

      const mongo = getDb();
      if (mongo) {
        for (const d of dates) {
          await mongo.collection('departures').updateOne(
            { date: d },
            { $set: { date: d, active: !!active, updatedAt: new Date().toISOString() } },
            { upsert: true }
          );
        }
      } else if (admin && admin.firestore) {
        for (const d of dates) {
          await admin.firestore().collection('departures').doc(d).set({ date: d, active: !!active, updatedAt: new Date().toISOString() }, { merge: true });
        }
      } else {
        const file = path.join(__dirname, '..', 'departures.json');
        let list = [];
        if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
        for (const d of dates) {
          const idx = list.findIndex(x => x.date === d);
          if (idx !== -1) { list[idx].active = !!active; list[idx].updatedAt = new Date().toISOString(); }
          else list.unshift({ date: d, active: !!active, updatedAt: new Date().toISOString() });
        }
        fs.writeFileSync(file, JSON.stringify(list, null, 2));
      }

      // broadcast current active list
      const getCurrent = async () => {
        const m = getDb();
        if (m) {
          const docs = await m.collection('departures').find({ active: true }).toArray();
          return docs.map(d => d.date);
        }
        if (admin && admin.firestore) {
          const snap = await admin.firestore().collection('departures').where('active','==',true).get();
          return snap.docs.map(d => d.id);
        }
        const file2 = path.join(__dirname, '..', 'departures.json');
        if (fs.existsSync(file2)) {
          const l = JSON.parse(fs.readFileSync(file2, 'utf8') || '[]');
          return l.filter(x => x.active).map(x => x.date);
        }
        return [];
      };

      const current = await getCurrent();
      io.emit('departures_updated', { dates: current });

      res.json({ success: true, dates: current });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
