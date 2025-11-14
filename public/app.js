// public/app.js (versión corregida)
// Ejecutar solo cuando DOM esté listo y proteger por existencia de elementos.

document.addEventListener('DOMContentLoaded', () => {
  console.log('app.js: DOM listo — iniciando');

  const BASE = ''; // mismo dominio
  const SECTIONS = ['sombra', 'semisombra', 'sol'];

  // ELEMENTOS GENERALES (pueden o no existir según la página)
  const container = document.getElementById('sections-container');
  const logEl = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const backendUrlEl = document.getElementById('backend-url');

  if (backendUrlEl) backendUrlEl.textContent = location.origin;

  // charts y datos por sección (se crean solo si la vista tiene contenedor)
  const charts = {};
  const latestData = {};

  // Socket: inicializamos sólo si el navegador tiene la librería y hay interés en sockets.
  // Lo creamos global dentro de este scope para poder desconectarlo desde logout.
  let socket = null;
  try {
    if (typeof io !== 'undefined') {
      socket = io();
    } else {
      console.warn('app.js: socket.io no encontrado (io undefined)');
    }
  } catch (e) {
    console.warn('app.js: error inicializando socket.io', e);
    socket = null;
  }

  // UTIL: registrar log en UI si existe
  function log(msg) {
    console.log('app.log:', msg);
    if (!logEl) return;
    const p = document.createElement('div');
    p.textContent = `${new Date().toLocaleTimeString()} — ${msg}`;
    logEl.prepend(p);
  }

  // UTIL: actualizar DOM de una sección (protecciones incluidas)
  function updateSection(section, payload) {
    latestData[section] = payload || {};
    const elHs = document.getElementById(`${section}-hs`);
    const elLum = document.getElementById(`${section}-lum`);
    const elTemp = document.getElementById(`${section}-temp`);
    const elHa = document.getElementById(`${section}-ha`);
    const elVal = document.getElementById(`${section}-val`);

    if (elHs) elHs.textContent = payload?.humedad_suelo ?? '—';
    if (elLum) elLum.textContent = payload?.luminosidad ?? '—';
    if (elTemp) elTemp.textContent = payload?.temp ?? '—';
    if (elHa) elHa.textContent = payload?.humedad_amb ?? '—';
    if (elVal) elVal.textContent = payload?.valvula ?? '—';

    // actualizar gráfico si existe
    const ch = charts[section];
    if (ch && payload) {
      const now = new Date().toLocaleTimeString();
      ch.data.labels.push(now);
      ch.data.datasets[0].data.push(payload.humedad_suelo ?? 0);
      if (ch.data.labels.length > 20) {
        ch.data.labels.shift();
        ch.data.datasets[0].data.shift();
      }
      try { ch.update(); } catch(e){ console.warn('chart update error', e); }
    }
  }

  // CONTROL manual (UI) -> llama al proxy seguro /api/ui/control
  async function manualControl(section, action) {
    try {
      const body = { section, action };
      const token = localStorage.getItem('vivero_token') || localStorage.getItem('token') || '';
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      const res = await fetch(`/api/ui/control`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'same-origin'
      });

      if (!res.ok) {
        const txt = await res.text().catch(()=>null);
        log(`Control error ${res.status}: ${txt || res.statusText}`);
        return false;
      }
      const j = await res.json().catch(()=>null);
      if (j && j.ok) {
        log(`Control manual enviado: ${section} -> ${action}`);
        return true;
      } else {
        log(`Control respuesta inesperada: ${JSON.stringify(j)}`);
        return false;
      }
    } catch (err) {
      log('Error control (UI): ' + (err.message || err));
      return false;
    }
  }

  // === Código que construye tarjetas en pages donde exista `sections-container` ===
  if (container) {
    // limpiar y construir tarjeta por sección
    SECTIONS.forEach(s => {
      // crear DOM básico
      const card = document.createElement('div');
      card.className = 'section-card';
      card.id = `card-${s}`;
      card.innerHTML = `
        <h3>${s.charAt(0).toUpperCase()+s.slice(1)}</h3>
        <div class="metrics">
          <div class="metric">Humedad suelo: <strong id="${s}-hs">—</strong></div>
          <div class="metric">Luminosidad: <strong id="${s}-lum">—</strong></div>
          <div class="metric">Temp (°C): <strong id="${s}-temp">—</strong></div>
          <div class="metric">Humedad amb: <strong id="${s}-ha">—</strong></div>
          <div class="metric">Válvula: <strong id="${s}-val">—</strong></div>
        </div>
        <button class="valve-btn off" id="${s}-btn">Toggle Válvula</button>
        <canvas id="${s}-chart" style="height:120px"></canvas>
      `;
      container.appendChild(card);

      // inicializar chart si canvas existe y Chart está disponible
      const canvas = document.getElementById(`${s}-chart`);
      if (canvas && typeof Chart !== 'undefined') {
        try {
          const ctx = canvas.getContext('2d');
          charts[s] = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'Humedad suelo', data: [], fill:false, tension:0.2 }] },
            options: { responsive:true, scales:{ x:{ display:false }, y:{ beginAtZero:true }}}
          });
        } catch(err) {
          console.warn('chart create error', err);
        }
      }

      // asignar handler del botón si existe
      const btn = document.getElementById(`${s}-btn`);
      if (btn) {
        btn.addEventListener('click', async () => {
          const current = document.getElementById(`${s}-val`)?.textContent || 'off';
          const action = current === 'on' ? 'off' : 'on';
          btn.disabled = true;
          await manualControl(s, action);
          btn.disabled = false;
        });
      }
    });

    // función para cargar estado inicial desde el backend
    (async function fetchInitial() {
      if (statusEl) statusEl.textContent = 'Conectando al backend...';
      for (const s of SECTIONS) {
        try {
          const r = await fetch(`/api/valve/${s}`, { headers: {} }).catch(()=>null);
          const j = r ? await r.json().catch(()=>null) : null;
          if (j && j.ok) {
            const snap = await fetch(`/firebase-proxy?path=/vivero/secciones/${s}`).then(x => x.json()).catch(()=>null);
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
      if (statusEl) statusEl.textContent = 'Conectado';
    })();
  } // end if(container)

  // === Section detail page logic (si existe section.html con elementos concretos) ===
  const sectionTitleEl = document.getElementById('section-title');
  if (sectionTitleEl) {
    // extraer id de query param
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    if (id) {
      sectionTitleEl.textContent = id;
      const btnOn = document.getElementById('btn-on');
      const btnOff = document.getElementById('btn-off');
      const logsEl = document.getElementById('recent-logs');

      // inicializar charts solo si existen los canvas
      let soilChart = null, tempChart = null;
      const soilCanvas = document.getElementById('chart-soil');
      const tempCanvas = document.getElementById('chart-temp');
      if (soilCanvas && typeof Chart !== 'undefined') {
        try {
          soilChart = new Chart(soilCanvas.getContext('2d'), { type:'line', data:{labels:[], datasets:[{label:'Humedad suelo', data:[]}]}, options:{responsive:true} });
        } catch(e){ console.warn(e); }
      }
      if (tempCanvas && typeof Chart !== 'undefined') {
        try {
          tempChart = new Chart(tempCanvas.getContext('2d'), { type:'line', data:{labels:[], datasets:[{label:'Temp', data:[]}, {label:'Humedad amb', data:[]}]}, options:{responsive:true} });
        } catch(e){ console.warn(e); }
      }

      async function refresh() {
        try {
          const data = await fetch(`/firebase-proxy?path=/vivero/secciones/${encodeURIComponent(id)}`).then(x=>x.json()).catch(()=>null);
          if (!data) return;
          const lastReadEl = document.getElementById('last-read');
          if (lastReadEl) lastReadEl.textContent = data.ultima_actualizacion || '--';
          if (soilChart) {
            const now = new Date().toLocaleTimeString();
            soilChart.data.labels.push(now);
            soilChart.data.datasets[0].data.push(data.humedad_suelo ?? 0);
            if (soilChart.data.labels.length > 30) { soilChart.data.labels.shift(); soilChart.data.datasets[0].data.shift(); }
            soilChart.update();
          }
          if (tempChart) {
            const now = new Date().toLocaleTimeString();
            tempChart.data.labels.push(now);
            tempChart.data.datasets[0].data.push(data.temp ?? 0);
            tempChart.data.datasets[1].data.push(data.humedad_amb ?? 0);
            if (tempChart.data.labels.length > 30) { tempChart.data.labels.shift(); tempChart.data.datasets[0].data.shift(); tempChart.data.datasets[1].data.shift(); }
            tempChart.update();
          }
          // agregar log
          if (logsEl) {
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            entry.innerHTML = `<div style="font-weight:700">${data.ultima_actualizacion || new Date().toLocaleString()}</div>
              <div style="margin-top:6px"><strong>Humedad suelo:</strong> ${data.humedad_suelo ?? '-'} · <strong>Temp:</strong> ${data.temp ?? '-'} · <strong>Válvula:</strong> ${data.valvula ?? '-'}</div>`;
            logsEl.prepend(entry);
            while (logsEl.children.length > 50) logsEl.removeChild(logsEl.lastChild);
          }
        } catch(e) { console.warn('refresh section error', e); }
      }

      if (btnOn) btnOn.addEventListener('click', ()=> manualControl(id, 'on'));
      if (btnOff) btnOff.addEventListener('click', ()=> manualControl(id, 'off'));

      refresh();
      if (socket) {
        socket.on('sensor-update', d => { if (d.section === id) refresh(); });
      }
    } // end if id
  } // end if(sectionTitleEl)

  // === Socket event handlers generales (si socket fue creado) ===
  if (socket) {
    socket.on('connect', () => {
      if (statusEl) statusEl.textContent = 'Socket conectado';
      log('Socket.IO conectado');
    });

    socket.on('sensor-update', (data) => {
      try {
        const { section, payload, suggestion } = data;
        log(`Sensor update (${section}): ${suggestion?.suggestionText ?? ''}`);
        if (payload) {
          updateSection(section, payload);
        }
      } catch (e) { console.error(e); }
    });

    socket.on('control-update', (data) => {
      log(`Control update: ${data.section} -> ${data.action}`);
      // actualizar la sección afectada
      (async()=> {
        try {
          const snap = await fetch(`/firebase-proxy?path=/vivero/secciones/${data.section}`).then(x=>x.json()).catch(()=>null);
          if (snap) updateSection(data.section, snap);
        } catch(e){ console.warn(e); }
      })();
    });

    socket.on('disconnect', () => {
      if (statusEl) statusEl.textContent = 'Socket desconectado';
      log('Socket.IO desconectado');
    });
  }

  // === Logout + Theme handlers (si existen botones en la página) ===
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('vivero_token');
      localStorage.removeItem('token');
      sessionStorage.clear();
      try { if (socket && socket.disconnect) socket.disconnect(); } catch(e){}
      window.location.href = '/login.html';
    });
  }

  // Theme toggle (usa data-theme que ya definiste en tu CSS)
  const themeBtn = document.getElementById('theme-toggle');
  const root = document.documentElement;
  // aplicar preferencia guardada
  const saved = localStorage.getItem('vivero_theme') || 'dark';
  root.setAttribute('data-theme', saved);

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const cur = root.getAttribute('data-theme') || 'dark';
      const next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem('vivero_theme', next);
    });
  }

  // fin DOMContentLoaded
});
