const { MongoClient, ObjectId } = require('mongodb');

let client = null;
let db = null;

async function initMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;

  try {
    client = new MongoClient(uri);
    await client.connect();
    const dbName = process.env.MONGODB_DB_NAME || 'app';
    db = client.db(dbName);
    console.log('✅ MongoDB connecté:', db.databaseName);
    return db;
  } catch (e) {
    console.warn('⚠️ MongoDB connexion échouée:', e.message);
    db = null;
    return null;
  }
}

function getDb() {
  return db;
}

module.exports = { initMongo, getDb, ObjectId };
