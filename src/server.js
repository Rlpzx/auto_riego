// src/server.js
// Servidor Express + Socket.IO para recibir datos del Pico y escribir en Firebase Realtime DB
// Autenticación simple para dispositivos: X-API-KEY header
// Explicación abajo, linea por linea.

require('dotenv').config(); // carga variables desde .env en desarrollo
const fs = require('fs');
const path = require('path');

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Server } = require('socket.io');

const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);

// --- Socket.IO (tiempo real para frontend) ---
const io = new Server(server, {
  cors: {
    origin: '*' // en producción, cambia '*' por la URL de tu frontend
  }
});

// --- Middlewares ---
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// --- Cargar Service Account (en Render lo subiremos como Secret File)
// --- Cargar Service Account (soporta 2 modos: SERVICE_ACCOUNT_JSON o SERVICE_ACCOUNT_PATH) ---
const SERVICE_ACCOUNT_PATH = process.env.SERVICE_ACCOUNT_PATH || null;
let serviceAccountObj = null;

if (process.env.SERVICE_ACCOUNT_JSON && process.env.SERVICE_ACCOUNT_JSON.trim().length > 0) {
  // Modo despliegue: la variable de entorno contiene el JSON completo
  try {
    serviceAccountObj = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    console.log('Firebase Admin: usando SERVICE_ACCOUNT_JSON desde variables de entorno');
  } catch (err) {
    console.error('FATAL: SERVICE_ACCOUNT_JSON no es JSON válido:', err);
    process.exit(1);
  }
} else if (SERVICE_ACCOUNT_PATH) {
  // Modo local: cargamos desde archivo en disco (ruta absoluta o relativa)
  const path = require('path');
  const fs = require('fs');

  // Si la ruta es relativa, normalizamos respecto al proyecto
  const resolvedPath = path.isAbsolute(SERVICE_ACCOUNT_PATH)
    ? SERVICE_ACCOUNT_PATH
    : path.join(__dirname, '..', SERVICE_ACCOUNT_PATH.replace(/^\.\//, ''));

  if (!fs.existsSync(resolvedPath)) {
    console.error('FATAL: no se encuentra el Service Account JSON en la ruta:', resolvedPath);
    console.error('Verifica SERVICE_ACCOUNT_PATH en .env o usa SERVICE_ACCOUNT_JSON en producción.');
    process.exit(1);
  }

  try {
    serviceAccountObj = require(resolvedPath);
    console.log('Firebase Admin: usando Service Account desde archivo:', resolvedPath);
  } catch (err) {
    console.error('FATAL: error cargando Service Account desde archivo:', err);
    process.exit(1);
  }
} else {
  console.error('FATAL: No se proporcionó SERVICE_ACCOUNT_JSON ni SERVICE_ACCOUNT_PATH. Define al menos una.');
  process.exit(1);
}

// Inicializar Firebase Admin SDK
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountObj),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  console.log('Firebase Admin inicializado correctamente.');
} catch (err) {
  console.error('FATAL: error inicializando Firebase Admin:', err);
  process.exit(1);
}

const db = admin.database();


// --- Configuración básica del sistema (umbrales por sección; personaliza) ---
const SECTIONS = {
  sombra: { soilThreshold: 400, tempHigh: 32, tempLow: 10 },
  semisombra: { soilThreshold: 350, tempHigh: 34, tempLow: 10 },
  sol: { soilThreshold: 300, tempHigh: 36, tempLow: 10 }
};

// Utilidad: validar API key enviada por Pico o frontend
function checkApiKey(req) {
  const apiKey = req.header('x-api-key') || req.query.api_key;
  return apiKey && process.env.API_KEY && apiKey === process.env.API_KEY;
}

// --- Endpoint principal: el Pico envía lecturas aquí ---
// Método: POST /api/data
// Headers: { "Content-Type": "application/json", "x-api-key": "<tu_api_key>" }
// Body ejemplo:
// {
//   "section": "sombra",
//   "humedad_suelo": 450,
//   "luminosidad": 300,
//   "temp": 26.5,
//   "humedad_amb": 65,
//   "device_id": "pico-01"
// }
app.post('/api/data', async (req, res) => {
  try {
    if (!checkApiKey(req)) {
      return res.status(401).json({ error: 'Unauthorized: invalid API key' });
    }

    const payload = req.body;
    const { section, device_id } = payload;
    if (!section || !SECTIONS[section]) {
      return res.status(400).json({ error: 'Invalid or missing "section" field' });
    }

    // Timestamp ISO
    const timestamp = new Date().toISOString();
    payload.ultima_actualizacion = timestamp;

    // Guardar en Firebase Realtime DB en /vivero/secciones/<section>
    const refPath = `/vivero/secciones/${section}`;
    await db.ref(refPath).update(payload);

    // Ejecutar lógica de riego simple
    const suggestion = evaluateAndMaybeTriggerValve(section, payload);

    // Emitir evento a clientes conectados via Socket.IO
    io.emit('sensor-update', { section, payload, suggestion });

    return res.json({ ok: true, suggestion });
  } catch (err) {
    console.error('Error /api/data', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Endpoint para controlar válvula manualmente desde la web (o móvil)
// POST /api/control
// Body: { "section":"sombra", "action":"on" }  action = "on" | "off"
// Headers: x-api-key
app.post('/api/control', async (req, res) => {
  try {
    if (!checkApiKey(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { section, action } = req.body;
    if (!section || !['on','off'].includes(action)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Actualizar DB
    const refPath = `/vivero/secciones/${section}`;
    await db.ref(refPath).update({ valvula: action, ultima_actualizacion: new Date().toISOString(), manual_override: true });

    // Emitir evento
    io.emit('control-update', { section, action });

    // Nota: aqui deberías enviar además un comando al microcontrolador para abrir/cerrar la válvula.
    // Opciones: 1) El Pico consulta periódicamente la DB y aplica el estado 'valvula' 2) Implementar push al Pico (más complejo)
    return res.json({ ok: true, section, action });
  } catch (err) {
    console.error('Error /api/control', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Endpoint simple para status ---
app.get('/api/status', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// --- Lógica de riego automatizada (muy simple) ---
function evaluateAndMaybeTriggerValve(section, payload) {
  const cfg = SECTIONS[section];
  if (!cfg) return { msg: 'no config' };

  const soil = payload.humedad_suelo;
  const temp = payload.temp;
  const suggestions = [];

  if (soil <= cfg.soilThreshold) {
    // Decide abrir válvula (en este prototipo, actualizamos la DB y ponemos valvula = "on")
    db.ref(`/vivero/secciones/${section}`).update({ valvula: 'on', ultima_actualizacion: new Date().toISOString(), reason: 'auto_soil_low' }).catch(console.error);
    suggestions.push('Humedad de suelo baja -> abriendo válvula automáticamente.');
  } else {
    // Si el suelo está bien, cerramos la válvula si estaba abierta por auto
    // NOTA: no forzamos el cierre si manual_override está activo (mejor política a futuro)
    db.ref(`/vivero/secciones/${section}`).once('value').then(snap => {
      const data = snap.val() || {};
      if (data.valvula === 'on' && data.manual_override !== true && soil > cfg.soilThreshold + 50) {
        db.ref(`/vivero/secciones/${section}`).update({ valvula: 'off', ultima_actualizacion: new Date().toISOString(), reason: 'soil_ok' }).catch(console.error);
      }
    }).catch(console.error);
    suggestions.push('Humedad de suelo adecuada.');
  }

  if (temp >= cfg.tempHigh) suggestions.push('Temperatura alta: revisar ventilación/sombra.');
  if (temp <= cfg.tempLow) suggestions.push('Temperatura baja: proteger plantas si es necesario.');

  const suggestionText = suggestions.join(' ');
  return { suggestions, suggestionText };
}

// --- Socket.IO connection handling (logs simples) ---
io.on('connection', (socket) => {
  console.log('Nuevo cliente conectado (socket id):', socket.id);
  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

// --- Iniciar servidor ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor vivo en puerto ${PORT}`);
});
