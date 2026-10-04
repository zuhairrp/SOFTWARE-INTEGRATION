// server.js — Distance Monitor Backend
// Does 3 things: reads distance data (real Arduino or mock), saves it to a
// database, and pushes it live to the browser dashboard.

const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
const { DatabaseSync } = require("node:sqlite"); // built into Node, no install needed

const PORT = 3000;

// -------------------------------------------------
// Set this to false once your Arduino is plugged in and you've set the
// correct ARDUINO_PORT below.
// -------------------------------------------------
const MOCK_MODE = process.env.MOCK_MODE !== "false";
const ARDUINO_PORT = process.env.ARDUINO_PORT || "COM3"; // e.g. "/dev/ttyUSB0" on Mac/Linux
const BAUD_RATE = 9600;
const MAX_RANGE_CM = 400;

// ---------- DATABASE ----------
const db = new DatabaseSync(path.join(__dirname, "distance.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    distance REAL,
    timestamp TEXT NOT NULL
  )
`);
const insertStmt = db.prepare("INSERT INTO readings (distance, timestamp) VALUES (?, ?)");
const recentStmt = db.prepare("SELECT * FROM readings ORDER BY id DESC LIMIT ?");
const rangeStmt = db.prepare(
  "SELECT * FROM readings WHERE timestamp >= ? AND timestamp <= ? ORDER BY id ASC"
);
const datesStmt = db.prepare(
  "SELECT DISTINCT substr(timestamp, 1, 10) as day FROM readings ORDER BY day DESC"
);

// Returns a sortable, ISO-like timestamp string in LOCAL time (not UTC),
// so raw entries in distance.db match your actual wall-clock time.
// Example: "2026-09-26T22:15:03" instead of a UTC time 5:30 hours behind
// (for IST). Still sorts correctly since it's YYYY-MM-DD HH:MM:SS order.
function localTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds())
  );
}

function saveReading(distance) {
  const timestamp = localTimestamp();
  const info = insertStmt.run(distance, timestamp);
  return { id: Number(info.lastInsertRowid), distance, timestamp };
}

// ---------- SERVER + WEBSOCKET ----------
const app = express();
app.use(express.static(path.join(__dirname, "..", "frontend")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(reading) {
  const msg = JSON.stringify(reading);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on("connection", (ws) => {
  // send recent history immediately so the graph isn't empty on load
  const rows = recentStmt.all(30).reverse();
  ws.send(JSON.stringify({ history: rows }));
});

app.get("/api/recent", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(recentStmt.all(limit).reverse());
});

// Readings between two ISO datetimes, e.g.
// /api/range?from=2026-09-26T00:00:00&to=2026-09-26T23:59:59
app.get("/api/range", (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: "Provide both 'from' and 'to' query params" });
  }
  res.json(rangeStmt.all(from, to));
});

// List of calendar dates (YYYY-MM-DD) that have any data, for quick-pick buttons
app.get("/api/dates", (req, res) => {
  res.json(datesStmt.all().map((r) => r.day));
});

function handleDistance(distance) {
  if (!Number.isFinite(distance) || distance < -1 || distance > MAX_RANGE_CM) {
    console.warn(`Ignoring invalid distance reading: ${distance}`);
    return;
  }
  const reading = saveReading(distance);
  reading.raw = `distance:${distance}`;
  reading.source = MOCK_MODE ? "simulation" : "hardware";
  broadcast(reading);
}

// ---------- SENSOR INPUT ----------
if (MOCK_MODE) {
  console.log("[MOCK MODE] Simulating distance sensor data.");
  let distance = 40;
  setInterval(() => {
    distance += (Math.random() - 0.5) * 8;
    distance = Math.max(2, Math.min(400, distance));
    handleDistance(Math.round(distance * 10) / 10);
  }, 1000);
} else {
  const { SerialPort } = require("serialport");
  const { ReadlineParser } = require("@serialport/parser-readline");

  const port = new SerialPort({ path: ARDUINO_PORT, baudRate: BAUD_RATE });
  // Arduino Serial.println() normally ends in LF; accept both LF and CRLF.
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

  port.on("open", () => {
    console.log(`Connected to Arduino on ${ARDUINO_PORT} at ${BAUD_RATE} baud`);
    broadcast({ type: "status", source: "hardware", port: ARDUINO_PORT, connected: true });
  });
  port.on("close", () => {
    console.error(`Serial port ${ARDUINO_PORT} closed`);
    broadcast({ type: "status", source: "hardware", port: ARDUINO_PORT, connected: false });
  });
  port.on("error", (err) => {
    console.error(`Serial error on ${ARDUINO_PORT}:`, err.message);
    broadcast({ type: "status", source: "hardware", port: ARDUINO_PORT, connected: false, error: err.message });
  });

  parser.on("data", (line) => {
    const raw = line.trim();
    if (!raw) return;
    console.log(`[SERIAL ${ARDUINO_PORT}] ${raw}`);

    // Accept the documented distance:23.4 format and plain numeric lines.
    const match = raw.match(/^(?:distance\s*:\s*)?(-?\d+(?:\.\d+)?)$/i);
    if (!match) {
      console.warn(`[SERIAL ${ARDUINO_PORT}] Unrecognized line: ${raw}`);
      broadcast({ type: "raw", raw, source: "hardware", port: ARDUINO_PORT });
      return;
    }
    const distance = Number(match[1]);
    const reading = saveReading(distance);
    reading.raw = raw;
    reading.source = "hardware";
    broadcast(reading);
  });
}

server.listen(PORT, () => {
  console.log(`Distance Monitor running at http://localhost:${PORT}`);
  console.log(`Mode: ${MOCK_MODE ? "MOCK" : "REAL ARDUINO on " + ARDUINO_PORT}`);
});
