const fs = require('fs');
const path = require('path');
const { verifyFirebaseToken, requireAdmin } = require('./lib/auth');

module.exports = function(app, io){
  const file = path.join(__dirname, 'dates.json');
  const settingsFile = path.join(__dirname, 'settings.json');

  function readDates(){
    try{
      if (!fs.existsSync(file)) return [];
      return JSON.parse(fs.readFileSync(file,'utf8')||'[]');
    }catch(e){ return []; }
  }

  function writeDates(dates){
    try{ fs.writeFileSync(file, JSON.stringify(dates, null, 2)); }
    catch(e){ console.error('writeDates error', e); }
  }

  // GET all dates
  app.get('/api/dates', (req, res) => {
    try{
      const dates = readDates();
      res.json(dates);
    }catch(e){ res.status(500).json({ error: e.message }); }
  });

  // POST batch update: { dates: [...], active: true|false }
  app.post('/api/dates', verifyFirebaseToken, requireAdmin, (req, res) => {
    try{
      const { dates, active } = req.body;
      if (!Array.isArray(dates)) return res.status(400).json({ error: 'dates must be array' });
      let cur = readDates();
      const set = new Set(cur);
      if (active) {
        dates.forEach(d => set.add(d));
      } else {
        dates.forEach(d => set.delete(d));
      }
      const next = Array.from(set).sort();
      writeDates(next);
      io.emit('departures_updated', { dates: next });
      res.json({ success: true, dates: next });
    }catch(e){ res.status(500).json({ error: e.message }); }
  });

  // POST single date: { date, active }
  app.post('/api/dates/single', verifyFirebaseToken, requireAdmin, (req, res) => {
    try{
      const { date, active } = req.body;
      if (!date) return res.status(400).json({ error: 'date required' });
      let cur = readDates();
      const set = new Set(cur);
      if (active) set.add(date); else set.delete(date);
      const next = Array.from(set).sort();
      writeDates(next);
      io.emit('departures_updated', { dates: next });

      // update settings.json selectedDate for admin visibility
      try {
        let settings = {};
        if (fs.existsSync(settingsFile)) {
          try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8') || '{}'); } catch(e){ settings = {}; }
        }
        settings.selectedDate = active ? date : null;
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
        io.emit('settings_updated', settings);
      } catch (e) { console.warn('failed to persist settings selectedDate', e); }

      res.json({ success: true, dates: next });
    }catch(e){ res.status(500).json({ error: e.message }); }
  });

  // DELETE single date via url param
  app.delete('/api/dates/:date', verifyFirebaseToken, requireAdmin, (req, res) => {
    try{
      const date = decodeURIComponent(req.params.date);
      let cur = readDates();
      const next = cur.filter(d => d !== date);
      writeDates(next);
      io.emit('departures_updated', { dates: next });

      // if the removed date was the selectedDate, clear it
      try {
        if (fs.existsSync(settingsFile)) {
          const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8') || '{}');
          if (settings.selectedDate === date) {
            settings.selectedDate = null;
            fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
            io.emit('settings_updated', settings);
          }
        }
      } catch (e) { console.warn('failed to update settings on date delete', e); }
      res.json({ success: true, dates: next });
    }catch(e){ res.status(500).json({ error: e.message }); }
  });
};
