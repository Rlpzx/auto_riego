// src/server.js
// Servidor Express + Socket.IO para recibir datos del Pico y escribir en Firebase Realtime DB

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

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');


const app = express();
const server = http.createServer(app);

// --- Socket.IO (tiempo real para frontend) ---
const io = new Server(server, {
  cors: {
    origin: '*' // en producción: cambia '*' por la URL de tu frontend
  }
});

// --- Middlewares ---
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));


// Rate limiter para login
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 6, // max 6 intentos por minute por IP
  standardHeaders: true,
  legacyHeaders: false
});

// Helper: verificar token JWT
function authMiddleware(req, res, next) {
  const auth = req.get('Authorization') || req.get('authorization') || req.header('Authorization') || req.header('authorization');
  if (!auth) return res.status(401).json({ ok:false, error:'missing auth' });
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ ok:false, error:'invalid auth format' });
  const token = parts[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ ok:false, error:'invalid token' });
  }
}


// Servir la carpeta public (UI) — pero primero interceptamos la raíz para redirigir al login
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Middleware muy simple: si el path es exactamente '/', redirigimos al login.
// Esto evita problemas con expresiones de ruta/comodines en path-to-regexp.
app.use((req, res, next) => {
  if (req.path === '/') {
    return res.redirect('/login.html');
  }
  return next();
});

// Ahora servimos archivos estáticos desde public
app.use(express.static(PUBLIC_DIR));

// Nota: no usamos app.get('/*') porque en algunas versiones provoca errores con path-to-regexp.
// Si quieres una captura global para SPA, usa una ruta basada en RegExp con cuidado,
// o mejor maneja la navegación desde el cliente (history API) y deja que el servidor sirva archivos estáticos.



// --- Cargar Service Account (soporta SERVICE_ACCOUNT_JSON o SERVICE_ACCOUNT_PATH) ---
const SERVICE_ACCOUNT_PATH = process.env.SERVICE_ACCOUNT_PATH || null;
let serviceAccountObj = null;

if (process.env.SERVICE_ACCOUNT_JSON && process.env.SERVICE_ACCOUNT_JSON.trim().length > 0) {
  try {
    serviceAccountObj = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    console.log('Firebase Admin: usando SERVICE_ACCOUNT_JSON desde variables de entorno');
  } catch (err) {
    console.error('FATAL: SERVICE_ACCOUNT_JSON no es JSON válido:', err);
    process.exit(1);
  }
} else if (SERVICE_ACCOUNT_PATH) {
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
app.post('/api/data', async (req, res) => {
  try {
    if (!checkApiKey(req)) {
      return res.status(401).json({ error: 'Unauthorized: invalid API key' });
    }

    const payload = req.body;
    const { section } = payload;
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
console.log('Emitido sensor-update -> section:', section, 'payload.humedad_suelo=', payload.humedad_suelo);


    return res.json({ ok: true, suggestion });
  } catch (err) {
    console.error('Error /api/data', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Endpoint para controlar válvula manualmente desde la web (o móvil)
app.post('/api/control', async (req, res) => {
  try {
    if (!checkApiKey(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { section, action } = req.body;
    if (!section || !['on','off'].includes(action)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const refPath = `/vivero/secciones/${section}`;
    await db.ref(refPath).update({ valvula: action, ultima_actualizacion: new Date().toISOString(), manual_override: true });

    io.emit('control-update', { section, action });

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

// --- Proxy seguro opcional para lecturas desde la UI ---
app.get('/firebase-proxy', async (req, res) => {
  try {
    const p = req.query.path;
    if (!p) return res.status(400).json({ error: 'missing path' });
    const snap = await db.ref(p).once('value');
    return res.json(snap.val());
  } catch (err) {
    console.error('firebase-proxy error', err);
    return res.status(500).json({ error: 'internal' });
  }
});
// GET /api/valve/:section  -> devuelve { ok:true, section, valvula, ultima_actualizacion, data }
app.get('/api/valve/:section', async (req, res) => {
  try {
    const section = req.params.section;
    if (!section || !SECTIONS[section]) return res.status(400).json({ ok: false, error: 'Invalid section' });

    // Leer desde Firebase
    const snap = await db.ref(`/vivero/secciones/${section}`).once('value');
    const data = snap.exists() ? snap.val() : {};

    const valvula = data.valvula || 'off';
    const ultima = data.ultima_actualizacion || null;

    return res.json({ ok: true, section, valvula, ultima_actualizacion: ultima, data });
  } catch (err) {
    console.error('Error /api/valve/:section', err);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});


// --- Lógica de riego automatizada (muy simple) ---
function evaluateAndMaybeTriggerValve(section, payload) {
  const cfg = SECTIONS[section];
  if (!cfg) return { msg: 'no config' };

  const soil = payload.humedad_suelo;
  const temp = payload.temp;
  const suggestions = [];

  if (soil <= cfg.soilThreshold) {
    db.ref(`/vivero/secciones/${section}`).update({ valvula: 'on', ultima_actualizacion: new Date().toISOString(), reason: 'auto_soil_low' }).catch(console.error);
    suggestions.push('Humedad de suelo baja -> abriendo válvula automáticamente.');
  } else {
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




// POST /api/auth/login  -> { ok:true, token }
app.post('/api/auth/login', loginLimiter, express.json(), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok:false, error:'missing fields' });

    const adminEmail = process.env.ADMIN_EMAIL;
    // si tienes hash en env:
    const adminHash = process.env.ADMIN_PASSWORD_HASH || null;
    const adminPlain = process.env.ADMIN_PLAIN_PASSWORD || null;

    if (email !== adminEmail) return res.status(401).json({ ok:false, error:'invalid credentials' });

    // validar contraseña: si hay hash usamos bcrypt, sino comparamos plain (dev)
    let ok = false;
    if (adminHash) {
      ok = await bcrypt.compare(password, adminHash);
    } else if (adminPlain) {
      ok = password === adminPlain;
    }

    if (!ok) return res.status(401).json({ ok:false, error:'invalid credentials' });

    const token = jwt.sign({ email: adminEmail, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '8h' });
    return res.json({ ok:true, token });
  } catch (err) {
    console.error('login error', err);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

// GET /api/auth/me -> info sobre token
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ ok:true, user: req.user });
});

// POST /api/ui/control
// Este endpoint es llamado por la UI (sin API key). El servidor valida origen/sesión y aplica el control
app.post('/api/ui/control', authMiddleware, async (req, res) => {

  try {
    // Opcional: validar origen o sesión
    // if (req.get('origin') && !req.get('origin').includes('your-frontend-domain')) return res.status(403).json({ ok:false, error:'forbidden' });

    // Alternativa más segura: validar sesión / cookie / JWT aquí
    const { section, action } = req.body;
    if (!section || !['on','off'].includes(action)) return res.status(400).json({ ok:false, error:'invalid payload' });

    // Internamente usamos la lógica existente: actualizamos la DB (sin exponer API_KEY)
    const refPath = `/vivero/secciones/${section}`;
    await db.ref(refPath).update({ valvula: action, ultima_actualizacion: new Date().toISOString(), manual_override: true });

    // Emitimos evento a los clientes conectados
    io.emit('control-update', { section, action });

    return res.json({ ok:true, section, action });
  } catch (err) {
    console.error('Error /api/ui/control', err);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

// --- Iniciar servidor ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor vivo en puerto ${PORT}`);
});
