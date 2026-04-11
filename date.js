const fs = require('fs');
const path = require('path');

module.exports = function(app, io){
  const file = path.join(__dirname, 'dates.json');

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
  app.post('/api/dates', (req, res) => {
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
      io.emit('departures_updated', next);
      res.json({ success: true, dates: next });
    }catch(e){ res.status(500).json({ error: e.message }); }
  });

  // POST single date: { date, active }
  app.post('/api/dates/single', (req, res) => {
    try{
      const { date, active } = req.body;
      if (!date) return res.status(400).json({ error: 'date required' });
      let cur = readDates();
      const set = new Set(cur);
      if (active) set.add(date); else set.delete(date);
      const next = Array.from(set).sort();
      writeDates(next);
      io.emit('departures_updated', next);
      res.json({ success: true, dates: next });
    }catch(e){ res.status(500).json({ error: e.message }); }
  });

  // DELETE single date via url param
  app.delete('/api/dates/:date', (req, res) => {
    try{
      const date = decodeURIComponent(req.params.date);
      let cur = readDates();
      const next = cur.filter(d => d !== date);
      writeDates(next);
      io.emit('departures_updated', next);
      res.json({ success: true, dates: next });
    }catch(e){ res.status(500).json({ error: e.message }); }
  });
};
