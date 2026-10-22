// ============================================================
//  middleware/security.js — Endurecimiento de seguridad
// ============================================================
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { config } = require('../config');

// Content Security Policy razonable para este panel.
// Permite: el propio sitio, Google Fonts y conexiones websocket (socket.io).
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // el panel usa pequeños scripts inline
      scriptSrcAttr: ["'unsafe-inline'"], // handlers inline (onerror de avatares, etc.); los datos van escapados
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'], // avatares de WhatsApp vienen por https
      connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'", 'https:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// Límite de intentos de login: 10 cada 10 minutos por IP
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos. Esperá unos minutos.' },
});

// Límite general de la API: 300 requests por minuto por IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // En producción detrás de proxy (Hostinger/Nginx) usamos la IP real
  skip: () => config.env === 'development',
});

module.exports = { helmetMiddleware, loginLimiter, apiLimiter };
