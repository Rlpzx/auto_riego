// public/main-ui.js
// Theme toggle: aplicar preferencia guardada o por defecto modo oscuro
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vivero_theme', theme);
}
function initThemeToggle() {
  const saved = localStorage.getItem('vivero_theme') || 'dark';
  applyTheme(saved);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
  }
}
document.addEventListener('DOMContentLoaded', initThemeToggle);


// Proteger páginas internas: si no hay token válido, redirige al login.
// Esto NO se ejecuta en login.html (permitimos ver el login).
function requireAuthOnProtectedPages() {
  try {
    const path = (window.location.pathname.split('/').pop() || '').toLowerCase();
    // páginas públicas donde permitimos acceso sin token:
    const publicPages = ['login.html', '']; // '' = root (redirigido por servidor)
    if (publicPages.includes(path)) return;

    // Preferimos la key 'vivero_token' — por compatibilidad también chequeamos 'token'
    const token = localStorage.getItem('vivero_token') || localStorage.getItem('token');
    if (!token || token === 'null' || (typeof token === 'string' && token.trim() === '')) {
      // limpieza por seguridad
      localStorage.removeItem('vivero_token');
      localStorage.removeItem('token');
      // redirigir al login
      window.location.href = '/login.html';
    }
  } catch (e) {
    console.error('requireAuth error', e);
    // en caso de error, forzamos login por seguridad
    localStorage.removeItem('vivero_token');
    localStorage.removeItem('token');
    window.location.href = '/login.html';
  }
}


const mainUI = (() => {
  const BASE = ''; // la UI se sirve desde el mismo dominio
  const socket = io();
  const state = { sections: {}, soilTrend: [] };


  function isLogged() {
  return !!localStorage.getItem('vivero_token');
}
function logout() {
  localStorage.removeItem('vivero_token');
  localStorage.removeItem('token');
  sessionStorage.clear();
  window.location.href = '/login.html';
}

async function checkSessionAndUpdateUI() {
  const logged = isLogged();
  // Mostrar botón logout en header
  let authArea = document.getElementById('auth-area');
  if (!authArea) {
    authArea = document.createElement('div');
    authArea.id = 'auth-area';
    document.querySelector('.header').appendChild(authArea);
  }
  authArea.innerHTML = '';
  if (logged) {
    const out = document.createElement('button');
    out.className = 'btn ghost'; out.textContent = 'Salir';
    out.addEventListener('click', logout);
    authArea.appendChild(out);
  } else {
    const link = document.createElement('a');
    link.href = '/login.html'; link.className = 'btn'; link.textContent = 'Login';
    authArea.appendChild(link);
  }
}


 // Helper: fetch JSON safe (corregido)
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  // si quieres logs: console.log('fetch', url, r.status);
  if (!r.ok) {
    // lee texto para tener más contexto y lanzar error con info
    const txt = await r.text().catch(()=>null);
    const msg = txt ? `HTTP ${r.status} - ${txt}` : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  // intentar parseo seguro
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    // si no es JSON, devolver texto crudo
    return text;
  }
}
// pequeña utilidad para mostrar mensajes al usuario (status / toasts)
function showStatus(message, kind='info', timeout=4000) {
  try {
    let box = document.getElementById('ui-status-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ui-status-box';
      box.style.position = 'fixed';
      box.style.right = '18px';
      box.style.top = '18px';
      box.style.zIndex = 9999;
      document.body.appendChild(box);
    }
    const entry = document.createElement('div');
    entry.textContent = message;
    entry.style.marginBottom = '8px';
    entry.style.padding = '10px 12px';
    entry.style.borderRadius = '8px';
    entry.style.color = '#072027';
    entry.style.background = kind === 'error' ? '#fca5a5' : (kind === 'success' ? '#bbf7d0' : '#bae6fd');
    box.prepend(entry);
    setTimeout(()=> {
      try { box.removeChild(entry); } catch(e){}
      // eliminar caja si vacía
      if (box.children.length === 0) box.remove();
    }, timeout);
  } catch (e) {
    console.log('showStatus error', e);
  }
}



  // Cargar lista de secciones desde Firebase via proxy
  async function loadSectionsList() {
    try {
      // Asumimos que en la DB hay /vivero/secciones con keys
      const data = await fetchJson(`${BASE}/firebase-proxy?path=/vivero/secciones`);
      // data is object of sections
      state.sections = data || {};
      return state.sections;
    } catch (e) {
      console.warn('loadSectionsList error', e);
      return {};
    }
  }

  // Render tarjeta compacta para dashboard
  function renderQuickSections(containerEl) {
    containerEl.innerHTML = '';
    const keys = Object.keys(state.sections).sort();
    document.getElementById('total-sections').textContent = keys.length;
    let valvesOpen = 0;
    keys.forEach(k => {
      const d = state.sections[k] || {};
      if (d.valvula === 'on') valvesOpen++;
      const card = document.createElement('div');
      card.className = 'section-card';
      card.innerHTML = `<div><h4>${k}</h4><div class="meta">Hum. suelo: ${d.humedad_suelo ?? '-'} · Temp: ${d.temp ?? '-'}</div></div>
        <div class="controls"><a href="/section.html?id=${encodeURIComponent(k)}" class="btn">Abrir</a></div>`;
      containerEl.appendChild(card);
    });
    document.getElementById('valves-open').textContent = valvesOpen;
  }

  // Dashboard init
  async function initDashboard() {
    document.getElementById('backend-url').textContent = location.origin;
    // load initial
    await loadSectionsList();
    renderQuickSections(document.getElementById('quick-sections'));
    // build small trend chart
    const ctx = document.getElementById('soil-trend').getContext('2d');
    const soilChart = new Chart(ctx, { type:'line', data:{ labels:[], datasets:[{label:'Humedad suelo', data:[], fill:false}] }, options:{responsive:true}});
    // compute KPIs
    updateKPIs();
    // socket updates
    socket.on('sensor-update', d => {
      // update local state and UI
      state.sections[d.section] = d.payload;
      renderQuickSections(document.getElementById('quick-sections'));
      updateKPIs();
      // add trend point
      soilChart.data.labels.push(new Date().toLocaleTimeString());
      soilChart.data.datasets[0].data.push(d.payload.humedad_suelo || 0);
      if (soilChart.data.labels.length > 20) { soilChart.data.labels.shift(); soilChart.data.datasets[0].data.shift(); }
      soilChart.update();
      // alerts
      if (d.suggestion && d.suggestion.suggestionText) {
        const alerts = document.getElementById('alerts');
        const p = document.createElement('div'); p.textContent = `${d.section}: ${d.suggestion.suggestionText}`; alerts.prepend(p);
      }
    });
  }

  function updateKPIs() {
    const keys = Object.keys(state.sections);
    if (!keys.length) return;
    let tSum=0, soilSum=0, luxSum=0, cnt=0, last=null;
    keys.forEach(k => {
      const v = state.sections[k];
      if (!v) return;
      if (v.temp) { tSum += Number(v.temp); }
      if (v.humedad_suelo) { soilSum += Number(v.humedad_suelo); }
      if (v.luminosidad) { luxSum += Number(v.luminosidad); }
      cnt++;
      last = v.ultima_actualizacion || last;
    });
    document.getElementById('avg-temp').textContent = cnt? (tSum/cnt).toFixed(1)+' °C':'--';
    document.getElementById('avg-soil').textContent = cnt? Math.round(soilSum/cnt):'--';
    document.getElementById('avg-lux').textContent = cnt? Math.round(luxSum/cnt):'--';
    document.getElementById('last-update').textContent = last? new Date(last).toLocaleString():'--';
  }

  // Sections page
  async function initSections() {
    const container = document.getElementById('sections-container');
    document.getElementById('refresh-btn').addEventListener('click', async ()=> { await reloadSections(); });
    document.getElementById('filter-input').addEventListener('input', e => filterSections(e.target.value));
    await reloadSections();
    socket.on('sensor-update', d => { state.sections[d.section]=d.payload; reloadSections(); });
  }

 async function reloadSections() {
  await loadSectionsList();
  const container = document.getElementById('sections-container');
  if (!container) {
    console.warn('reloadSections: sections-container no encontrado en DOM');
    return;
  }
  container.innerHTML = '';
  const keys = Object.keys(state.sections || {}).sort();
  keys.forEach(k => {
    const v = state.sections[k] || {};
    const el = document.createElement('div');
    el.className = 'section-card';
    el.innerHTML = `<div><h4>${k}</h4><div class="meta">Hum: ${v.humedad_suelo ?? '-'} · Temp: ${v.temp ?? '-'}</div></div>
      <div class="controls"><a href="/section.html?id=${encodeURIComponent(k)}" class="btn">Ver</a></div>`;
    container.appendChild(el);
  });
  const totalEl = document.getElementById('total-sections');
  if (totalEl) totalEl.textContent = keys.length;
}


  function filterSections(q) {
    const container = document.getElementById('sections-container');
    const items = Array.from(container.children);
    items.forEach(it => {
      const t = it.textContent.toLowerCase();
      it.style.display = t.includes(q.toLowerCase())? 'block':'none';
    });
  }

  // Section detail view
  async function initSectionView() {
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    if (!id) { document.getElementById('section-title').textContent = 'Sección no especificada'; return; }
    document.getElementById('section-title').textContent = id;
    const btnOn = document.getElementById('btn-on'), btnOff = document.getElementById('btn-off');
    btnOn.addEventListener('click', ()=> uiControl(id,'on'));
    btnOff.addEventListener('click', ()=> uiControl(id,'off'));

    // charts
    const ctxSoil = document.getElementById('chart-soil').getContext('2d');
    const soilChart = new Chart(ctxSoil, { type:'line', data:{labels:[], datasets:[{label:'Humedad suelo', data:[]}]}, options:{responsive:true}});

    const ctxTemp = document.getElementById('chart-temp').getContext('2d');
    const tempChart = new Chart(ctxTemp, { type:'line', data:{labels:[], datasets:[{label:'Temp', data:[]}, {label:'Humedad amb', data:[]}]}, options:{responsive:true}});

    // load recent (simple: query proxy last node — we assume realtime DB keeps last record at /vivero/secciones/<id>)
    async function refresh() {
      try {
        const data = await fetchJson(`/firebase-proxy?path=/vivero/secciones/${encodeURIComponent(id)}`);
        if (!data) return;
        document.getElementById('last-read').textContent = data.ultima_actualizacion || '--';
        // push points
        const now = new Date().toLocaleTimeString();
        if (data.humedad_suelo !== undefined) { soilChart.data.labels.push(now); soilChart.data.datasets[0].data.push(data.humedad_suelo); }
        if (data.temp !== undefined) { tempChart.data.labels.push(now); tempChart.data.datasets[0].data.push(data.temp); tempChart.data.datasets[1].data.push(data.humedad_amb || 0); }
        if (soilChart.data.labels.length>30) { soilChart.data.labels.shift(); soilChart.data.datasets[0].data.shift(); tempChart.data.labels.shift(); tempChart.data.datasets[0].data.shift(); tempChart.data.datasets[1].data.shift(); }
        soilChart.update(); tempChart.update();

       const logs = document.getElementById('recent-logs');
if (logs) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  // Formateo de fecha
  let dateStr = '--';
  try {
    if (data.ultima_actualizacion) {
      const d = new Date(data.ultima_actualizacion);
      dateStr = d.toLocaleString();
    } else {
      dateStr = new Date().toLocaleString();
    }
  } catch (e) { dateStr = data.ultima_actualizacion || new Date().toLocaleString(); }

  // Contenido legible
  entry.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font-weight:700">${dateStr}</div>
      <div style="font-size:13px;color:var(--muted)">Device: ${data.device_id ?? '-'}</div>
    </div>
    <div style="margin-top:6px">
      <strong>Humedad suelo:</strong> ${data.humedad_suelo ?? '-'} &nbsp; | &nbsp;
      <strong>Luminosidad:</strong> ${data.luminosidad ?? '-'} &nbsp; | &nbsp;
      <strong>Temp:</strong> ${data.temp ?? '-'} °C &nbsp; | &nbsp;
      <strong>Humedad amb:</strong> ${data.humedad_amb ?? '-'}
    </div>
    <div style="margin-top:6px;color:var(--muted);font-size:13px">
      <span>Válvula: <strong>${data.valvula ?? '-'}</strong></span>
      ${data.reason ? ` · <span>Razón: ${data.reason}</span>` : ''}
    </div>
  `;

  // prepend y limitar cantidad de entradas mostradas (ej. 50)
  logs.prepend(entry);
  const maxEntries = 50;
  while (logs.children.length > maxEntries) logs.removeChild(logs.lastChild);
}

      } catch(e){ console.warn(e) }
    }

    await refresh();
    socket.on('sensor-update', d => { if (d.section===id){ refresh(); } });
  }
  // --- Logout ---




  // UI control that posts to proxy endpoint
 // UI control that posts to proxy endpoint (mejorado: loader, optimistic update, mensajes)
async function uiControl(section, action) {
  try {
    // UI: deshabilitar botones y mostrar "Enviando..."
    const btnOn = document.getElementById('btn-on');
    const btnOff = document.getElementById('btn-off');
    if (btnOn) btnOn.disabled = true;
    if (btnOff) btnOff.disabled = true;
    showStatus(`Enviando comando ${action} a ${section}...`, 'info');

    // Optimistic: mostrar estado en pantalla inmediatamente
    const valEl = document.getElementById(`${section}-val`) || document.getElementById('last-read');
    if (valEl) {
      // si existe la etiqueta específica de válvula la actualizamos visualmente
      try { document.querySelector(`#${section}-val`).textContent = action; } catch(e){}
    }

    const token = localStorage.getItem('vivero_token');
const headers = { 'Content-Type': 'application/json' };
if (token) headers['Authorization'] = 'Bearer ' + token;

const res = await fetch(`/api/ui/control`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ section, action })
});


    if (!res.ok) {
      const txt = await res.text().catch(()=>null);
      showStatus(`Error control: ${res.status} ${txt||''}`, 'error');
      // restaurar botones
      if (btnOn) btnOn.disabled = false;
      if (btnOff) btnOff.disabled = false;
      return;
    }

    const j = await res.json();
    showStatus(`Acción enviada: ${section} -> ${action}`, 'success');

    // opcional: actualizar UI local con la respuesta
    if (j && j.ok) {
      // actualizamos el DOM si existe
      try {
        const elem = document.getElementById(`${section}-val`);
        if (elem) elem.textContent = action;
      } catch(e){}
    }

    // re-habilitar botones (el socket actualizará el estado definitivo)
    if (btnOn) btnOn.disabled = false;
    if (btnOff) btnOff.disabled = false;

  } catch (err) {
    console.error('uiControl error', err);
    showStatus('Error de conexión al enviar control', 'error');
    const btnOn = document.getElementById('btn-on');
    const btnOff = document.getElementById('btn-off');
    if (btnOn) btnOn.disabled = false;
    if (btnOff) btnOff.disabled = false;
  }
}

  // Reports page
  async function initReports() {
    const canvas = document.getElementById('report-soil').getContext('2d');
    const chart = new Chart(canvas, { type:'bar', data:{ labels:[], datasets:[{label:'Humedad promedio', data:[]}] }});
    document.getElementById('gen-report').addEventListener('click', async () => {
      // simple demo: average current sections
      await loadSectionsList();
      const keys = Object.keys(state.sections);
      chart.data.labels = keys;
      chart.data.datasets[0].data = keys.map(k => state.sections[k]?.humedad_suelo || 0);
      chart.update();
    });
  }

  // Settings page
  async function initSettings() {
    document.getElementById('save-settings').addEventListener('click', ()=> alert('Guardado (demo)'));
    const simulate = document.getElementById('simulate');
    simulate.addEventListener('change', async (e) => {
      // llamar al backend para habilitar simulación global (implementar si lo deseas)
      alert('Cambio guardado (demo)');
    });
  }

  return {
    initDashboard, initSections, initSectionView, initReports, initSettings
  };
})();
// Auto-inicializador: detecta la página y llama a la init correspondiente
document.addEventListener('DOMContentLoaded', () => {
  // validar sesión en páginas protegidas
  requireAuthOnProtectedPages();

  // inicializar tema y mostrar botón login/logout
  initThemeToggle();

  // actualizar UI de sesión (el auth-area se genera por mainUI más adelante)
  // Llamamos a checkSessionAndUpdateUI desde dentro de mainUI una vez que la init correspondiente corra.

  const p = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (p === '' || p === 'index.html') {
    if (mainUI.initDashboard) mainUI.initDashboard();
  } else if (p === 'sections.html') {
    if (mainUI.initSections) mainUI.initSections();
  } else if (p === 'section.html') {
    if (mainUI.initSectionView) mainUI.initSectionView();
  } else if (p === 'reports.html') {
    if (mainUI.initReports) mainUI.initReports();
  } else if (p === 'settings.html') {
    if (mainUI.initSettings) mainUI.initSettings();
  } else {
    // fallback: try dashboard
    if (mainUI.initDashboard) mainUI.initDashboard();
  }
});
