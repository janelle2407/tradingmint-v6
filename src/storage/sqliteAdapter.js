const path = require("path");

function createSqliteAdapter() {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    return {
      available: false,
      reason: "better-sqlite3 not installed or not available. JSON database fallback active."
    };
  }

  const dbPath = path.join(__dirname, "../../data/tradingmint.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      time TEXT,
      type TEXT,
      symbol TEXT,
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      time TEXT,
      payload TEXT
    );
  `);

  return {
    available: true,
    dbPath,
    insertEvent(event) {
      const stmt = db.prepare("INSERT OR REPLACE INTO events (id,time,type,symbol,payload) VALUES (?,?,?,?,?)");
      stmt.run(event.id, event.time, event.eventType || event.type, event.symbol || "-", JSON.stringify(event));
    },
    insertSnapshot(snapshot) {
      const id = "SNAP-" + Date.now();
      const stmt = db.prepare("INSERT OR REPLACE INTO snapshots (id,time,payload) VALUES (?,?,?)");
      stmt.run(id, new Date().toISOString(), JSON.stringify(snapshot));
    }
  };
}

module.exports = { createSqliteAdapter };
