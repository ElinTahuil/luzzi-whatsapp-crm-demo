// ============================================================
//  routes/webhook.js — Webhook de WhatsApp Cloud API
//   - GET:  verificación inicial del webhook (Meta).
//   - POST: recepción de mensajes y estados, ruteados al negocio
//           correcto según phone_number_id.
// ============================================================
const express = require('express');
const router = express.Router();
const { config } = require('../config');
const { query } = require('../db');
const { handleIncoming, handleEcho, handleAppStateSync, handleHistorySync, handleStatus, handleAccountUpdate, verifySignature } = require('../services/whatsapp');

// Verificación del webhook (Meta envía un GET una sola vez)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('✅ Webhook verificado');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Busca el negocio conectado a un evento de Meta usando el phone_number_id.
// Los eventos normales y los de coexistencia traen este dato en metadata.
async function businessFromWebhookValue(value) {
  const phoneNumberId = value?.metadata?.phone_number_id || value?.phone_number_id || '';
  if (!phoneNumberId) return null;

  const businesses = await query(
    'SELECT * FROM businesses WHERE whatsapp_phone_number_id = ? AND active = 1 LIMIT 1',
    [phoneNumberId]
  );
  const business = businesses[0];
  if (!business) console.warn(`Webhook para phone_number_id desconocido: ${phoneNumberId}`);
  return business || null;
}

async function processWebhookValue(field, value, io) {
  if (!value) return;
  const normalizedField = String(field || '').toLowerCase();
  const business = await businessFromWebhookValue(value);
  if (!business) return;

  // Coexistencia: historial inicial aceptado por el dueño en la app. Es una
  // importación; no dispara bot ni respuestas automáticas.
  if (normalizedField === 'history' || Array.isArray(value.history)) {
    await handleHistorySync(value, business, io);
    return;
  }

  // Coexistencia: contactos de la agenda de WhatsApp Business del dueño.
  if (normalizedField === 'smb_app_state_sync' || Array.isArray(value.state_sync)) {
    await handleAppStateSync(value, business, io);
    return;
  }

  // Coexistencia: el cliente desconectó/reconectó su número desde su app, o el
  // número se descargó por cambio de dispositivo. Llega como account_update con
  // value.event = PARTNER_REMOVED / ACCOUNT_OFFBOARDED / ACCOUNT_RECONNECTED, etc.
  const ACCOUNT_EVENTS = ['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED', 'DISABLED_UPDATE', 'ACCOUNT_DELETED', 'ACCOUNT_VIOLATION'];
  if (normalizedField === 'account_update' || (value.event && ACCOUNT_EVENTS.includes(String(value.event).toUpperCase()))) {
    await handleAccountUpdate(value, business, io);
    return;
  }

  // Mensajes entrantes. Estos SÍ son conversaciones activas del cliente y por
  // eso pasan por el bot/reglas/menú/handoff normal.
  if (Array.isArray(value.messages)) {
    for (const message of value.messages) {
      const contact = value.contacts?.[0];
      await handleIncoming(message, contact, business, io);
    }
  }

  // Coexistencia: mensajes que el dueño manda desde la app de WhatsApp Business
  // o un dispositivo vinculado. Se guardan como salientes manuales y no disparan bot.
  if (Array.isArray(value.message_echoes)) {
    for (const echo of value.message_echoes) {
      await handleEcho(echo, business, io);
    }
  }

  // Estados (enviado / entregado / leído / fallido) de mensajes salientes.
  if (Array.isArray(value.statuses)) {
    for (const status of value.statuses) {
      await handleStatus(status, business, io);
    }
  }
}

// Recepción de eventos
router.post('/', async (req, res) => {
  // 1) Validar firma (X-Hub-Signature-256) antes de procesar
  const signature = req.get('x-hub-signature-256');
  if (!verifySignature(req.rawBody || Buffer.from(''), signature)) {
    console.warn('⚠️  Webhook con firma inválida. Descartado.');
    return res.sendStatus(401);
  }

  // 2) Responder rápido a Meta (procesamos en segundo plano)
  res.sendStatus(200);

  try {
    const body = req.body;
    const io = req.app.get('io');

    // Algunos eventos de coexistencia pueden llegar como evento directo
    // { event, data } (especialmente history / smb_app_state_sync). Los
    // soportamos además del formato estándar object/entry/changes.
    if (body.event && body.data) {
      await processWebhookValue(body.event, body.data, io);
      return;
    }

    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        await processWebhookValue(change.field, change.value, io);
      }
    }
  } catch (err) {
    console.error('Error en webhook:', err.message);
  }
});

module.exports = router;
