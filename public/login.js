// public/login.js
(async () => {
  const emailEl = document.getElementById('login-email');
  const passEl = document.getElementById('login-pass');
  const btn = document.getElementById('login-btn');
  const msg = document.getElementById('login-msg');

  function showMsg(text, isError=false) {
    msg.textContent = text;
    msg.style.color = isError ? '#ff6b6b' : 'var(--muted)';
  }

  async function doLogin() {
    showMsg('');
    btn.disabled = true;
    try {
      const email = emailEl.value.trim();
      const password = passEl.value;
      if (!email || !password) {
        showMsg('Ingresa email y contraseña', true);
        btn.disabled = false;
        return;
      }

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      if (!res.ok) {
        showMsg('Credenciales inválidas', true);
        btn.disabled = false;
        return;
      }

      const j = await res.json();
      if (j && j.ok && j.token) {
        localStorage.setItem('vivero_token', j.token);
        // redirige al dashboard
        window.location.href = '/index.html';
      } else {
        showMsg('Error de autenticación', true);
        btn.disabled = false;
      }
    } catch (err) {
      console.error('login error', err);
      showMsg('Error de conexión', true);
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', doLogin);
  passEl.addEventListener('keyup', (e) => { if (e.key === 'Enter') doLogin(); });

  // opcional: si ya hay token, redirigir automáticamente
  const existing = localStorage.getItem('vivero_token');
  if (existing) {
    // puedes validar token con /api/auth/me si quieres, aquí redirigimos directo
    window.location.href = '/index.html';
  }
})();
