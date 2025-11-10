// public/app.js
(() => {
  const API_KEY = null; // si el backend requiere header, el navegador pedirá CORS. Dejar nulo para no exponer clave.
  // Si quieres enviar la API_KEY desde la UI (no recomendable), define aquí. Mejor pedir control autenticado en backend.

  // URL base -> se asume que la UI está servida desde el mismo dominio que el backend
  const BASE = '';

  // Secciones que usaremos
  const SECTIONS = ['sombra', 'semisombra', 'sol'];

  const container = document.getElementById('sections-container');
  const logEl = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const backendUrlEl = document.getElementById('backend-url');

  backendUrlEl.textContent = location.origin;

  // Crear tarjetas de sección
  const charts = {};
  const latestData = {};

  SECTIONS.forEach(s => {
    const card = document.createElement('div');
    card.className = 'section-card';
    card.id = `card-${s}`;
    card.innerHTML = `
      <h3>${s.charAt(0).toUpperCase() + s.slice(1)}</h3>
      <div class="metrics">
        <div class="metric">Humedad suelo: <strong id="${s}-hs">—</strong></div>
        <div class="metric">Luminosidad: <strong id="${s}-lum">—</strong></div>
        <div class="metric">Temp (°C): <strong id="${s}-temp">—</strong></div>
        <div class="metric">Humedad amb: <strong id="${s}-ha">—</strong></div>
        <div class="metric">Válvula: <strong id="${s}-val">—</strong></div>
      </div>
      <button class="valve-btn off" id="${s}-btn">Toggle Válvula</button>
      <canvas id="${s}-chart"></canvas>
    `;
    container.appendChild(card);

    // Chart for soil humidity history
    const ctx = document.getElementById(`${s}-chart`).getContext('2d');
    charts[s] = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [{ label: 'Humedad suelo', data: [], fill:false, tension:0.2 }] },
      options: { responsive:true, scales:{ x:{ display:false }, y:{ beginAtZero:true }}}
    });

    // button handler
    const btn = document.getElementById(`${s}-btn`);
    btn.addEventListener('click', () => {
      const current = document.getElementById(`${s}-val`).textContent;
      const action = current === 'on' ? 'off' : 'on';
      manualControl(s, action);
    });
  });

  // append log
  function log(msg) {
    const p = document.createElement('div');
    p.textContent = `${new Date().toLocaleTimeString()} — ${msg}`;
    logEl.prepend(p);
  }

  // Update UI with payload
  function updateSection(section, payload) {
    latestData[section] = payload;
    document.getElementById(`${section}-hs`).textContent = payload.humedad_suelo ?? '—';
    document.getElementById(`${section}-lum`).textContent = payload.luminosidad ?? '—';
    document.getElementById(`${section}-temp`).textContent = payload.temp ?? '—';
    document.getElementById(`${section}-ha`).textContent = payload.humedad_amb ?? '—';
    document.getElementById(`${section}-val`).textContent = payload.valvula ?? '—';

    // add data point to chart
    const ch = charts[section];
    if (ch) {
      const now = new Date().toLocaleTimeString();
      ch.data.labels.push(now);
      ch.data.datasets[0].data.push(payload.humedad_suelo ?? 0);
      if (ch.data.labels.length > 20) {
        ch.data.labels.shift();
        ch.data.datasets[0].data.shift();
      }
      ch.update();
    }
  }

  // Manual control button -> calls /api/control
  // Manual control button -> calls /api/control (with API key for local testing)
// Manual control button -> calls /api/ui/control (proxy endpoint in server)
async function manualControl(section, action) {
  try {
    const body = { section, action };
    const res = await fetch(`/api/ui/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin'
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=>null);
      log(`Control error ${res.status}: ${txt || res.statusText}`);
      return;
    }
    const j = await res.json();
    if (j.ok) {
      log(`Control manual (UI) enviado: ${section} -> ${action}`);
    } else {
      log(`Control error: ${JSON.stringify(j)}`);
    }
  } catch (err) {
    log('Error control (UI): ' + err.message);
  }
}


  // Poll initial states from server for each section
  async function fetchInitial() {
    statusEl.textContent = 'Conectando al backend...';
    for (const s of SECTIONS) {
      try {
        const r = await fetch(`${BASE}/api/valve/${s}`, { headers: {} });
        const j = await r.json();
        if (j && j.ok) {
          // fetch full data from DB path /vivero/secciones/<s>
          const snap = await fetch(`${BASE}/firebase-proxy?path=/vivero/secciones/${s}`).then(x => x.json()).catch(()=>null);
          if (snap) {
            updateSection(s, snap);
            log(`Estado inicial cargado para ${s}`);
          } else if (j.valvula) {
            updateSection(s, { valvula: j.valvula });
          }
        }
      } catch (err) {
        console.warn('fetchInitial error', err);
      }
    }
    statusEl.textContent = 'Conectado';
  }

  // Socket.IO connect
  const socket = io();

  socket.on('connect', () => {
    statusEl.textContent = 'Socket conectado';
    log('Socket.IO conectado');
  });

  socket.on('sensor-update', (data) => {
    try {
      const { section, payload, suggestion } = data;
      log(`Sensor update (${section}): ${suggestion?.suggestionText ?? ''}`);
      if (payload) updateSection(section, payload);
    } catch (e) { console.error(e) }
  });

  socket.on('control-update', (data) => {
    log(`Control update: ${data.section} -> ${data.action}`);
    // fetch latest for that section
    (async()=> {
      try {
        const snap = await fetch(`${BASE}/firebase-proxy?path=/vivero/secciones/${data.section}`).then(x=>x.json()).catch(()=>null);
        if (snap) updateSection(data.section, snap);
      } catch(e){}
    })();
  });

  socket.on('disconnect', () => {
    statusEl.textContent = 'Socket desconectado';
    log('Socket.IO desconectado');
  });

  // Start
  fetchInitial();

})();
