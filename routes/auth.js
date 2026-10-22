// ============================================================
//  routes/auth.js — Autenticación del administrador
// ============================================================
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { query } = require('../db');
const { requireApi } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/security');

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/conversations');
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

router.post('/login', loginLimiter, async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!username || !password) {
    return res.json({ success: false, message: 'Completá usuario y contraseña' });
  }
  try {
    const users = await query('SELECT * FROM admins WHERE username = ?', [username]);
    // Comparamos siempre (incluso si no existe) para no filtrar tiempos
    const user = users[0];
    const hash = user ? user.password : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinva';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      return res.json({ success: false, message: 'Usuario o contraseña incorrectos' });
    }

    req.session.admin = {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      is_owner: !!user.is_owner,
    };
    res.json({ success: true });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// Datos del admin logueado (para mostrar en el front)
router.get('/me', requireApi, (req, res) => {
  res.json(req.session.admin);
});

router.put('/profile', requireApi, async (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body;
  try {
    const users = await query('SELECT * FROM admins WHERE id = ?', [req.session.admin.id]);
    const user = users[0];
    if (!user) return res.status(404).json({ success: false, message: 'No encontrado' });

    if (newPassword) {
      if (String(newPassword).length < 6) {
        return res.json({ success: false, message: 'La nueva clave debe tener al menos 6 caracteres' });
      }
      const valid = await bcrypt.compare(currentPassword || '', user.password);
      if (!valid) return res.json({ success: false, message: 'Contraseña actual incorrecta' });
      const hashed = await bcrypt.hash(newPassword, 12);
      await query('UPDATE admins SET name = ?, email = ?, password = ? WHERE id = ?', [
        name, email, hashed, user.id,
      ]);
    } else {
      await query('UPDATE admins SET name = ?, email = ? WHERE id = ?', [name, email, user.id]);
    }

    req.session.admin.name = name;
    req.session.admin.email = email;
    res.json({ success: true, message: 'Perfil actualizado' });
  } catch (err) {
    console.error('Profile error:', err.message);
    res.status(500).json({ success: false, message: 'Error al actualizar' });
  }
});

module.exports = router;
