// ============================================================
//  middleware/auth.js — Protección de rutas
// ============================================================

// Para rutas de API: responde 401 JSON si no hay sesión
function requireApi(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// Para rutas del panel (HTML): redirige al login
function requirePage(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.redirect('/auth/login');
  }
  next();
}

module.exports = { requireApi, requirePage };
