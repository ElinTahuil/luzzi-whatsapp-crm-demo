// ============================================================
//  services/whatsapp.js — Integración con WhatsApp Cloud API (Meta)
//  Mejoras vs v1:
//   - Versión del Graph API configurable (default v21.0).
//   - Credenciales POR NEGOCIO (multi-tenant real).
//   - Manejo de la ventana de 24h (mensajes libres vs plantillas).
//   - Recepción de multimedia (imagen, audio, documento, etc.).
//   - Marcar como leído (tilde azul real).
//   - Verificación de firma X-Hub-Signature-256.
// ============================================================
const axios = require('axios');
const crypto = require('crypto');
const { config } = require('../config');
const { query } = require('../db');
const { decideReply, parseButtons } = require('./responder');
const appointments = require('./appointments');
const { matchRule, getMenuOption } = require('./rules');
const { maybeQualifyLead } = require('./leads');
const push = require('./push');
const { sendEmail } = require('./email');
const { applyEffectiveSettings } = require('./plans');
const { publicFileUrl } = require('./fileLinks');

const GRAPH = `https://graph.facebook.com/${config.whatsapp.apiVersion}`;

function client(business) {
  return axios.create({
    baseURL: GRAPH,
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${business.whatsapp_access_token}`,
      'Content-Type': 'application/json',
    },
  });
}



// ---- Verificación de firma del webhook ----
// Meta firma el body con tu App Secret. Validarlo evita payloads falsos.
function verifySignature(rawBody, signatureHeader) {
  if (!config.whatsapp.appSecret) return true; // si no está configurado, no bloqueamos (pero avisamos en config)
  if (!signatureHeader) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

// ---- Enviar texto libre (solo válido dentro de la ventana de 24h) ----
async function sendText(business, phone, text) {
  try {
    const res = await client(business).post(`/${business.whatsapp_phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { preview_url: false, body: text },
    });
    return res.data.messages?.[0]?.id;
  } catch (err) {
    const apiErr = err.response?.data?.error;
    const e = new Error(apiErr?.message || err.message);
    e.waCode = apiErr?.code;
    // 131047 / 131026 => fuera de la ventana de 24h: hay que usar plantilla
    e.windowClosed = [131047, 131026].includes(apiErr?.code);
    console.error('WhatsApp sendText error:', apiErr || err.message);
    throw e;
  }
}

// ---- Enviar un documento (PDF, etc.) como ADJUNTO por URL ----
// WhatsApp descarga el archivo desde 'link' (la ruta pública firmada del CRM) y
// lo entrega como adjunto en el chat. Solo válido dentro de la ventana de 24h.
async function sendDocument(business, phone, { link, filename, caption }) {
  const res = await client(business).post(`/${business.whatsapp_phone_number_id}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'document',
    document: {
      link,
      filename: String(filename || 'documento').slice(0, 240),
      ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
    },
  });
  return res.data.messages?.[0]?.id;
}

// ---- Enviar botones de respuesta rápida (hasta 3) ----
// buttons: [{ id, title }]. Solo válido dentro de la ventana de 24h.
async function sendInteractiveButtons(business, phone, body, buttons) {
  try {
    const res = await client(business).post(`/${business.whatsapp_phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(body || '').slice(0, 1024) },
        action: {
          buttons: (buttons || []).slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: String(b.id).slice(0, 256), title: String(b.title || '').slice(0, 20) || '—' },
          })),
        },
      },
    });
    return res.data.messages?.[0]?.id;
  } catch (err) {
    const apiErr = err.response?.data?.error;
    const e = new Error(apiErr?.message || err.message);
    e.waCode = apiErr?.code;
    e.windowClosed = [131047, 131026].includes(apiErr?.code);
    console.error('WhatsApp interactive(button) error:', apiErr || err.message);
    throw e;
  }
}

// ---- Enviar lista de opciones (hasta 10) ----
// rows: [{ id, title, description? }]
async function sendInteractiveList(business, phone, body, buttonLabel, rows) {
  try {
    const res = await client(business).post(`/${business.whatsapp_phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: String(body || '').slice(0, 1024) },
        action: {
          button: String(buttonLabel || 'Ver opciones').slice(0, 20),
          sections: [
            {
              title: 'Opciones',
              rows: (rows || []).slice(0, 10).map((r) => ({
                id: String(r.id).slice(0, 200),
                title: String(r.title || '').slice(0, 24) || '—',
                description: r.description ? String(r.description).slice(0, 72) : undefined,
              })),
            },
          ],
        },
      },
    });
    return res.data.messages?.[0]?.id;
  } catch (err) {
    const apiErr = err.response?.data?.error;
    const e = new Error(apiErr?.message || err.message);
    e.waCode = apiErr?.code;
    e.windowClosed = [131047, 131026].includes(apiErr?.code);
    console.error('WhatsApp interactive(list) error:', apiErr || err.message);
    throw e;
  }
}

// ---- Enviar el menú principal: botones si son <=3, lista si son más ----
// options: filas de menu_options (con id + title). El id de respuesta es "OPT:<id>".
async function sendMenu(business, phone, body, options) {
  const opts = (options || []).slice(0, 10);
  if (opts.length <= 3) {
    const buttons = opts.map((o) => ({ id: 'OPT:' + o.id, title: o.title }));
    return sendInteractiveButtons(business, phone, body, buttons);
  }
  const rows = opts.map((o) => ({ id: 'OPT:' + o.id, title: o.title }));
  return sendInteractiveList(business, phone, body, 'Ver opciones', rows);
}

// ---- Enviar plantilla aprobada (para reabrir conversaciones fuera de 24h) ----
async function sendTemplate(business, phone, templateName, languageCode = 'es_AR', components = []) {
  try {
    const res = await client(business).post(`/${business.whatsapp_phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, components },
    });
    return res.data.messages?.[0]?.id;
  } catch (err) {
    const apiErr = err.response?.data?.error;
    const e = new Error(apiErr?.message || err.message);
    e.waCode = apiErr?.code;
    e.waDetail = apiErr?.error_data?.details;
    console.error('WhatsApp sendTemplate error:', apiErr || err.message);
    throw e;
  }
}

// Envía una plantilla probando varios códigos de idioma (por si quedó guardada como
// 'es' en vez de 'es_AR', o viceversa). Solo reintenta ante el error 132001
// ("la plantilla no existe en ese idioma"); ante otro error, corta.
async function sendTemplateAnyLang(business, phone, templateName, langs, components = []) {
  const list = [...new Set((langs || []).filter(Boolean))];
  if (!list.length) list.push('es_AR');
  let lastErr;
  for (const code of list) {
    try {
      const wamid = await sendTemplate(business, phone, templateName, code, components);
      return { wamid, lang: code };
    } catch (e) {
      lastErr = e;
      if (e.waCode !== 132001) throw e;
    }
  }
  throw lastErr;
}

// ---- Marcar un mensaje entrante como leído (tilde azul para el contacto) ----
async function markAsRead(business, waMessageId) {
  if (!waMessageId) return;
  try {
    await client(business).post(`/${business.whatsapp_phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: waMessageId,
    });
  } catch (err) {
    console.error('WhatsApp markAsRead error:', err.response?.data?.error || err.message);
  }
}

// ---- Foto de perfil del contacto (best-effort) ----
async function getProfilePicture(phone, business) {
  try {
    const res = await client(business).get(`/${phone}`, {
      params: { fields: 'profile_picture_url' },
    });
    return res.data.profile_picture_url || null;
  } catch {
    return null;
  }
}

// ---- Descargar multimedia entrante (2 pasos: URL firmada -> binario) ----
async function downloadMedia(business, mediaId) {
  const meta = await client(business).get(`/${mediaId}`);
  const url = meta.data.url;
  const bin = await axios.get(url, {
    headers: { Authorization: `Bearer ${business.whatsapp_access_token}` },
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  return { buffer: Buffer.from(bin.data), mime: meta.data.mime_type || 'application/octet-stream' };
}

// ---- Normaliza un mensaje entrante a una forma simple ----
function parseIncoming(message) {
  const base = { type: message.type, text: '', mediaId: null, caption: '', filename: '', interactiveId: '' };
  switch (message.type) {
    case 'text':
      base.text = message.text?.body || '';
      break;
    case 'image':
      base.mediaId = message.image?.id;
      base.caption = message.image?.caption || '';
      base.text = base.caption || '📷 Imagen';
      break;
    case 'audio':
    case 'voice':
      base.mediaId = message.audio?.id;
      base.text = '🎤 Audio';
      break;
    case 'video':
      base.mediaId = message.video?.id;
      base.caption = message.video?.caption || '';
      base.text = base.caption || '🎥 Video';
      break;
    case 'document':
      base.mediaId = message.document?.id;
      base.filename = message.document?.filename || 'documento';
      base.caption = message.document?.caption || '';
      base.text = `📎 ${base.filename}`;
      break;
    case 'sticker':
      base.mediaId = message.sticker?.id;
      base.text = '🟦 Sticker';
      break;
    case 'location':
      base.text = `📍 Ubicación: ${message.location?.latitude}, ${message.location?.longitude}`;
      break;
    case 'button':
      base.text = message.button?.text || '';
      base.interactiveId = message.button?.payload || '';
      break;
    case 'interactive':
      base.interactiveId =
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id || '';
      base.text =
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        '(respuesta interactiva)';
      break;
    default:
      base.text = `(${message.type})`;
  }
  return base;
}

// ---- Procesa un mensaje entrante ----
// Detecta si el cliente pide hablar con una persona / humano.
function detectHandoff(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return /(hablar|comunicar|comunicarme|contactar|atienda|atienda|deriv|pasame|paseme|quiero|necesito)\s+.*(human[oa]|persona|asesor|agente|representante|alguien|encargad[oa]|due[ñn]o|vendedor|ejecutiv[oa])/.test(t)
    || /\b(un humano|una persona|persona real|atenci[oó]n humana|un operador|un asesor|una asesora|un agente|hablar con alguien)\b/.test(t);
}

// Avisa al dueño que un cliente pide atención humana por TODOS los canales
// disponibles: panel (socket), push al celular, WhatsApp y email.
// El push y el email NO dependen de que el negocio tenga WhatsApp configurado.
async function notifyOwnerHandoff(business, contact, io) {
  // 1) Panel en vivo (suena/avisa si hay alguna pestaña abierta)
  try {
    io.emit('handoff', {
      businessId: business.id, businessName: business.name, contactId: contact.id,
      phone: contact.phone, name: contact.name, timestamp: new Date(),
    });
  } catch {}

  // 2) Push al celular del dueño (funciona con la app cerrada)
  push.notifyHandoff(business, contact)
    .then((r) => { if (r && r.sent) console.log(`🔔 Push de derivación enviado a ${r.sent} dispositivo(s).`); })
    .catch((e) => console.warn('Push de derivación falló:', e.message));

  // 3) Email de respaldo (si hay credenciales de Gmail configuradas)
  if (config.email.notify) {
    sendEmail({
      subject: `🙋 Pedido de atención humana — ${contact.name || contact.phone}`,
      html: `
        <h2>Un cliente pidió hablar con una persona</h2>
        <p><strong>Negocio:</strong> ${business.name || '-'}</p>
        <p><strong>Cliente:</strong> ${contact.name || 'Sin nombre'}</p>
        <p><strong>Teléfono:</strong> ${contact.phone}</p>
        <p><strong>Fecha:</strong> ${new Date().toLocaleString('es-AR')}</p>
        <br><a href="${config.appUrl}/conversations">Abrir la conversación →</a>`,
    }).catch(() => {});
  }

  // 4) WhatsApp al número del dueño (canal EXTRA y de PAGO). Por defecto APAGADO:
  //    solo se manda si el dueño lo activó (app_settings 'owner_wa_alert' = '1').
  //    Los avisos de arriba (panel en vivo, push y email) son gratis y ya alcanzan.
  try {
    const waFlag = await query("SELECT value FROM app_settings WHERE name = 'owner_wa_alert'");
    if (!(waFlag.length && String(waFlag[0].value) === '1')) {
      console.log('Handoff: aviso por WhatsApp al dueño DESACTIVADO (se avisó gratis por panel/push/email).');
      return;
    }
  } catch (e) { return; } // ante cualquier duda, no mandamos (no gastamos)
  const owner = config.owner.whatsapp;
  if (!owner) return;
  if (config.owner.businessSlug && business.slug && business.slug !== config.owner.businessSlug) {
    console.log(`Handoff en "${business.slug}": no se alerta por WhatsApp (configurado solo para "${config.owner.businessSlug}").`);
    return;
  }
  if (!business.whatsapp_access_token || !business.whatsapp_phone_number_id) {
    console.log('Handoff: el negocio no tiene WhatsApp configurado; se avisó por push/email/panel.');
    return;
  }
  try {
    const components = [{
      type: 'body',
      parameters: [
        { type: 'text', text: contact.name || contact.phone },
        { type: 'text', text: contact.phone },
        { type: 'text', text: business.name || 'tu negocio' },
      ],
    }];
    await sendTemplateAnyLang(business, owner, config.owner.handoffTemplate, [config.owner.handoffLang, 'es', 'es_AR'], components);
  } catch (e) {
    console.warn(`No se pudo avisar al dueño por WhatsApp (¿plantilla "${config.owner.handoffTemplate}" aprobada en Meta?):`, e.message);
  }
}

// Pasa la conversación a una persona: pausa el bot, avisa al cliente y al dueño.
async function triggerHandoff(business, contact, phone, io) {
  await query('UPDATE contacts SET needs_human = 1, needs_human_at = NOW(), bot_enabled = 0 WHERE id = ?', [contact.id]);
  contact.needs_human = 1;
  contact.bot_enabled = 0;
  try {
    const ack = 'Perfecto, te derivo con una persona del equipo. En breve te contactan 🙌';
    const wamid = await sendText(business, phone, ack);
    await query(
      `INSERT INTO messages (business_id, contact_id, role, type, content, whatsapp_message_id, status)
       VALUES (?, ?, 'assistant', 'text', ?, ?, 'sent')`,
      [business.id, contact.id, ack, wamid]
    );
    io.emit('new_message', {
      businessId: business.id, contactId: contact.id, phone, name: contact.name,
      avatar: contact.avatar, role: 'assistant', type: 'text', message: ack, timestamp: new Date(),
    });
  } catch (e) { /* la ventana podría estar cerrada; igual avisamos al dueño */ }
  await notifyOwnerHandoff(business, contact, io);
}

// Envía la respuesta decidida por la cadena (texto, botones de regla o menú) y la registra.
async function sendBotReply(business, contact, result, io) {
  const phone = contact.phone;
  const body = result.text || '';
  let wamid;
  let sentType = 'text';
  try {
    if (result.menu && result.menu.length) {
      wamid = await sendMenu(business, phone, body, result.menu);
      sentType = 'interactive';
    } else if (result.buttons && result.buttons.length) {
      const buttons = result.buttons.slice(0, 3).map((b, i) => ({
        id: 'KW:' + String(b.keyword || b.title || ('op' + i)).slice(0, 250),
        title: String(b.title || b.label || ('Opción ' + (i + 1))),
      }));
      wamid = await sendInteractiveButtons(business, phone, body, buttons);
      sentType = 'interactive';
    } else {
      wamid = await sendText(business, phone, body);
    }
    await query(
      `INSERT INTO messages (business_id, contact_id, role, type, content, whatsapp_message_id, status)
       VALUES (?, ?, 'assistant', ?, ?, ?, 'sent')`,
      [business.id, contact.id, sentType, body, wamid]
    );
    io.emit('new_message', {
      businessId: business.id, contactId: contact.id, phone, name: contact.name,
      avatar: contact.avatar, role: 'assistant', type: sentType, message: body, timestamp: new Date(),
    });

    // Adjuntos: si la respuesta trae archivos (ej: la factura), mandamos el PDF
    // adjunto y NADA de enlace (es lo más prolijo). El enlace de respaldo se manda
    // SOLO si el adjunto no se pudo enviar (sin URL pública o falló el envío), para
    // que el cliente igual pueda verlo. Si después dice "no lo puedo abrir", el
    // motor conversacional le ofrece el enlace y, si tampoco, una persona.
    if (Array.isArray(result.files) && result.files.length) {
      const fallbackLinks = [];
      for (const file of result.files.slice(0, 3)) {
        const signed = publicFileUrl(file.id); // URL firmada y alcanzable por WhatsApp
        let attached = false;
        if (signed) {
          try {
            const docId = await sendDocument(business, phone, { link: signed, filename: file.filename });
            await query(
              `INSERT INTO messages (business_id, contact_id, role, type, content, whatsapp_message_id, status)
               VALUES (?, ?, 'assistant', 'document', ?, ?, 'sent')`,
              [business.id, contact.id, file.filename || 'documento', docId]
            );
            io.emit('new_message', {
              businessId: business.id, contactId: contact.id, phone, name: contact.name,
              avatar: contact.avatar, role: 'assistant', type: 'document', message: file.filename || 'documento', timestamp: new Date(),
            });
            attached = true;
          } catch (attErr) {
            console.error('Adjunto no enviado:', attErr.response?.data?.error?.message || attErr.message);
          }
        }
        // No se pudo adjuntar → guardamos un enlace de respaldo (firmado o público).
        if (!attached) {
          const link = signed || file.publicUrl || '';
          if (link) fallbackLinks.push(link);
        }
      }
      // Respaldo: solo si algún archivo no se pudo adjuntar.
      if (fallbackLinks.length) {
        const lead = fallbackLinks.length > 1 ? 'Si no te llegaron los archivos, los podés ver acá:' : 'Si no te llegó el archivo, lo podés ver acá:';
        const fbText = `${lead}\n${fallbackLinks.join('\n')}`;
        try {
          const fbId = await sendText(business, phone, fbText);
          await query(
            `INSERT INTO messages (business_id, contact_id, role, type, content, whatsapp_message_id, status)
             VALUES (?, ?, 'assistant', 'text', ?, ?, 'sent')`,
            [business.id, contact.id, fbText, fbId]
          );
          io.emit('new_message', {
            businessId: business.id, contactId: contact.id, phone, name: contact.name,
            avatar: contact.avatar, role: 'assistant', type: 'text', message: fbText, timestamp: new Date(),
          });
        } catch (e) {
          console.error('Enlace de respaldo no enviado:', e.message);
        }
      }
    }
  } catch (sendErr) {
    await query(
      `INSERT INTO messages (business_id, contact_id, role, type, content, status, error_reason)
       VALUES (?, ?, 'assistant', 'text', ?, 'failed', ?)`,
      [business.id, contact.id, body, sendErr.windowClosed ? 'Ventana de 24h cerrada' : sendErr.message]
    );
  }
}

async function handleIncoming(message, waContact, business, io) {
  try {
    const phone = message.from;
    const waMessageId = message.id;

    // Coexistencia: un mensaje 'unsupported' con error 131060 es ESPERADO. Pasa
    // cuando un usuario escribe por primera vez (típico desde un anuncio click-to-
    // WhatsApp) o usa un dispositivo companion no soportado. No es un mensaje real
    // para el bot: lo registramos en consola y salimos sin guardar ni responder.
    if (message.type === 'unsupported') {
      const code = message.errors?.[0]?.code;
      console.log(`ℹ️  Mensaje 'unsupported'${code ? ' (código ' + code + ')' : ''} de ${phone} en ${business.name}: se ignora (esperado en coexistencia).`);
      return;
    }

    const parsed = parseIncoming(message);

    // Buscar o crear contacto (único por negocio + canal + teléfono — ver
    // R66.11: "phone" ahora puede repetirse UNA vez por canal, así que se
    // filtra explícitamente por channel = 'whatsapp' para no confundirlo
    // con un contacto de otro canal que casualmente comparta el mismo valor).
    let rows = await query("SELECT * FROM contacts WHERE business_id = ? AND channel = 'whatsapp' AND phone = ?", [
      business.id,
      phone,
    ]);
    let contact = rows[0];

    if (!contact) {
      const name = waContact?.profile?.name || phone;
      const avatar = await getProfilePicture(phone, business);
      const result = await query(
        'INSERT INTO contacts (business_id, phone, name, meta_name, avatar, bot_enabled, blocked, last_inbound_at) VALUES (?, ?, ?, ?, ?, 1, 0, NOW())',
        [business.id, phone, name, waContact?.profile?.name || '', avatar]
      );
      rows = await query('SELECT * FROM contacts WHERE id = ?', [result.insertId]);
      contact = rows[0];
    } else {
      const metaName = waContact?.profile?.name || '';
      // Conservamos el nombre que viene de Meta para usarlo como respaldo, pero
      // no pisamos un nombre manual (`custom_name`) cargado por el operador.
      if (metaName && !contact.meta_name) {
        await query('UPDATE contacts SET meta_name = ?, last_inbound_at = NOW() WHERE id = ?', [metaName, contact.id]);
        contact.meta_name = metaName;
      } else {
        await query('UPDATE contacts SET last_inbound_at = NOW() WHERE id = ?', [contact.id]);
      }
    }

    if (contact.blocked) return;

    // Guardar el mensaje entrante
    await query(
      `INSERT INTO messages (business_id, contact_id, role, type, content, caption, media_id, whatsapp_message_id, status)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 'delivered')`,
      [business.id, contact.id, parsed.type, parsed.text, parsed.caption, parsed.mediaId, waMessageId]
    );

    io.emit('new_message', {
      businessId: business.id,
      contactId: contact.id,
      phone: contact.phone,
      name: contact.name,
      avatar: contact.avatar,
      role: 'user',
      type: parsed.type,
      message: parsed.text,
      mediaId: parsed.mediaId,
      timestamp: new Date(),
    });

    // Si el cliente escribe su nombre (por ejemplo: “soy Juan Pérez”), lo
    // guardamos como sugerencia. El operador decide si lo aplica; no pisamos
    // nombres manuales ni el nombre que viene de Meta.
    if (parsed.type === 'text' && !contact.custom_name) {
      const suggested = appointments.detectNameSuggestion(parsed.text);
      if (suggested && suggested !== contact.suggested_name) {
        await query('UPDATE contacts SET suggested_name = ?, suggested_name_source = ? WHERE id = ?', [suggested, 'mensaje del cliente', contact.id]);
        contact.suggested_name = suggested;
        contact.suggested_name_source = 'mensaje del cliente';
      }
    }

    // Pedido de hablar con una persona → derivación
    if (parsed.type === 'text' && detectHandoff(parsed.text) && !contact.needs_human) {
      await triggerHandoff(business, contact, phone, io);
      return;
    }

    // Si el bot está apagado para este contacto, no respondemos automáticamente
    if (!contact.bot_enabled) return;

    // Actuamos sobre texto o sobre respuestas de botones/menú. Multimedia → no respondemos.
    const isActionable = parsed.type === 'text' || !!parsed.interactiveId;
    if (!isActionable) return;

    const settingsRows = await query('SELECT * FROM bot_settings WHERE business_id = ?', [business.id]);
    // El objeto business viene de la tabla businesses e incluye plan/permisos.
    // applyEffectiveSettings bloquea IA si el plan no la permite, aunque el
    // cliente intente encenderla desde Configuración.
    const settings = applyEffectiveSettings(business, settingsRows[0] || {});

    // Avisar al panel que el bot está "escribiendo…"
    io.emit('bot_typing', { businessId: business.id, contactId: contact.id });

    // 1) Tap en una opción del MENÚ ("OPT:<id>")
    if (parsed.interactiveId && parsed.interactiveId.startsWith('OPT:')) {
      // "Otra consulta": válvula de escape universal. Invita a escribir libre;
      // el próximo mensaje pasa por la cadena normal (reglas → IA → humano).
      if (parsed.interactiveId === 'OPT:otra') {
        await sendBotReply(business, contact, { source: 'menu-otra', text: 'Dale, contame qué necesitás 👇 y te ayudo.' }, io);
        maybeQualifyLead(contact, business, io).catch((e) => console.error('qualify error:', e.message));
        return;
      }
      const optId = parseInt(parsed.interactiveId.slice(4), 10);
      const opt = await getMenuOption(business.id, optId);
      if (opt && opt.action === 'handoff') {
        await triggerHandoff(business, contact, phone, io);
        return;
      }
      // El bot no auto-rutea a módulos (stock/turnos/mercado). Cualquier opción
      // del menú (salvo handoff) responde con el texto configurado para esa
      // opción. La gestión de turnos/stock/etc. vive en el panel.
      if (opt) {
        await sendBotReply(business, contact, { source: 'menu-opt', text: opt.response || '' }, io);
        maybeQualifyLead(contact, business, io).catch((e) => console.error('qualify error:', e.message));
        return;
      }
      // si la opción no existe, seguimos al flujo normal usando el título
    }

    // Historial reciente (solo texto) para contexto de la IA
    const history = await query(
      "SELECT role, content FROM messages WHERE contact_id = ? AND type = 'text' ORDER BY created_at DESC LIMIT 10",
      [contact.id]
    );
    history.reverse();
    // Si el mensaje actual es texto, ya quedó en el historial: lo sacamos del contexto.
    const priorHistory = parsed.type === 'text' ? history.slice(0, -1) : history;

    // (Sin auto-ruteo) El bot no intercepta el texto para mandarlo a turnos ni a
    // mercado. Todo mensaje libre pasa por la cadena: reglas → menú → IA → respaldo.

    // 3) Tap en botón de una REGLA ("KW:<palabra>") → fuerza el motor de reglas
    let result;
    if (parsed.interactiveId && parsed.interactiveId.startsWith('KW:')) {
      const kw = parsed.interactiveId.slice(3);
      if (detectHandoff(kw)) {
        await triggerHandoff(business, contact, phone, io);
        return;
      }
      const rule = await matchRule(business.id, kw);
      result = rule
        ? { source: 'regla', text: rule.response, buttons: parseButtons(rule.buttons), ruleId: rule.id }
        : await decideReply({ businessId: business.id, settings, text: kw, history: priorHistory, sessionKey: `wa:${contact.id}`, contactId: contact.id, contactName: contact.name || '', contactPhone: contact.phone || phone || '' });
    } else {
      // 4) Flujo normal: reglas → menú → IA → respaldo
      result = await decideReply({ businessId: business.id, settings, text: parsed.text, history: priorHistory, sessionKey: `wa:${contact.id}`, contactId: contact.id, contactName: contact.name || '', contactPhone: contact.phone || phone || '' });
    }

    await sendBotReply(business, contact, result, io);

    // Calificación de lead (con debounce dentro del servicio de leads)
    maybeQualifyLead(contact, business, io).catch((e) => console.error('qualify error:', e.message));
  } catch (err) {
    console.error('Error en handleIncoming:', err.message);
  }
}

// ---- Procesa actualizaciones de estado (sent/delivered/read/failed) ----
async function handleStatus(status, business, io) {
  try {
    const id = status.id;
    const newStatus = status.status;
    if (!['delivered', 'read', 'failed'].includes(newStatus)) return;

    let errorReason = null;
    if (newStatus === 'failed') {
      errorReason = status.errors?.[0]?.title || status.errors?.[0]?.message || 'Error de envío';
    }

    await query('UPDATE messages SET status = ?, error_reason = ? WHERE whatsapp_message_id = ?', [
      newStatus,
      errorReason,
      id,
    ]);

    io.emit('message_status', { wamid: id, status: newStatus, businessId: business.id });
  } catch (err) {
    console.error('Error en handleStatus:', err.message);
  }
}

// ============================================================
//  Coexistencia (app de WhatsApp Business + CRM en el mismo número)
// ------------------------------------------------------------
//  Cuando la coexistencia está activa, el número queda funcionando en
//  paralelo: app del celular + Cloud API. Para que el CRM no quede ciego
//  frente a lo que pasa en el celular, Meta envía tres eventos extra:
//
//    - smb_message_echoes: mensajes que el dueño manda desde la app.
//    - smb_app_state_sync: contactos guardados/actualizados en la app.
//    - history: historial que el dueño aceptó compartir al conectar.
//
//  Importante: estos eventos NO deben disparar el bot. Son sincronización
//  de estado/historial, no mensajes nuevos que requieran respuesta automática.
// ------------------------------------------------------------
const ECHO_AGENT = 'WhatsApp (app)';
const HISTORY_AGENT = 'WhatsApp (historial)';
const SMB_SYNC_TYPES = ['history', 'smb_app_state_sync'];

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseMetaUnixTimestamp(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeMessageStatus(value, fallback = 'delivered') {
  return ['sent', 'delivered', 'read', 'failed'].includes(value) ? value : fallback;
}

async function findOrCreateContactForSync(business, phone, name, options = {}) {
  const cleanPhone = onlyDigits(phone);
  if (!cleanPhone) return null;

  // R66.11: filtrado explícito por canal (ver nota en handleIncoming).
  let rows = await query("SELECT * FROM contacts WHERE business_id = ? AND channel = 'whatsapp' AND phone = ?", [
    business.id,
    cleanPhone,
  ]);
  let contact = rows[0];

  if (!contact) {
    // En sync/history no siempre conviene pedir avatar: pueden venir cientos o
    // miles de contactos y eso multiplicaría llamadas a Meta. Para mensajes
    // nuevos normales, handleIncoming/handleEcho siguen buscando avatar.
    const displayName = name || cleanPhone;
    const result = await query(
      `INSERT INTO contacts (business_id, phone, name, avatar, bot_enabled, blocked, last_inbound_at)
       VALUES (?, ?, ?, NULL, 1, 0, ${options.touchInbound ? 'NOW()' : 'NULL'})`,
      [business.id, cleanPhone, displayName]
    );
    rows = await query('SELECT * FROM contacts WHERE id = ?', [result.insertId]);
    return rows[0];
  }

  // Si el teléfono ya existía, actualizamos el nombre solo cuando el nombre
  // anterior estaba vacío o era el propio número. Así no pisamos una edición
  // manual hecha desde el CRM con un dato menos preciso del teléfono.
  const updates = [];
  const params = [];
  if (name && (!contact.name || contact.name === contact.phone)) {
    updates.push('name = ?');
    params.push(name);
    contact.name = name;
  }
  if (options.touchInbound) updates.push('last_inbound_at = NOW()');
  if (updates.length) {
    params.push(contact.id);
    await query(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`, params);
  }
  return contact;
}

async function insertSyncedMessage({ business, contact, role, parsed, waMessageId, status, agent, timestamp }) {
  // Dedupe por ID de WhatsApp: los webhooks pueden reintentarse y el history
  // puede llegar por chunks. Si ya existe, no lo volvemos a insertar.
  if (waMessageId) {
    const dup = await query('SELECT id FROM messages WHERE whatsapp_message_id = ? LIMIT 1', [waMessageId]);
    if (dup.length) return false;
  }

  const content = parsed.text || parsed.caption || `(${parsed.type || 'mensaje'})`;
  const createdAtSql = timestamp ? 'FROM_UNIXTIME(?)' : 'NOW()';
  const params = [
    business.id,
    contact.id,
    role,
    parsed.type || 'text',
    content,
    parsed.caption || null,
    parsed.mediaId || null,
    waMessageId || null,
    safeMessageStatus(status, role === 'assistant' ? 'delivered' : 'delivered'),
    agent || null,
  ];
  if (timestamp) params.push(timestamp);

  await query(
    `INSERT INTO messages (business_id, contact_id, role, type, content, caption, media_id, whatsapp_message_id, status, agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${createdAtSql})`,
    params
  );
  return true;
}

async function handleEcho(echo, business, io) {
  try {
    const phone = echo.to; // el cliente (destinatario del mensaje del dueño)
    const waMessageId = echo.id;
    if (!phone) return;

    // Dedupe por wamid: cubre el redelivery del webhook y el caso límite de que
    // el propio CRM ya lo hubiera guardado (los mensajes mandados por la Cloud
    // API no generan echo, pero deduplicamos igual por las dudas).
    if (waMessageId) {
      const dup = await query('SELECT id FROM messages WHERE whatsapp_message_id = ? LIMIT 1', [
        waMessageId,
      ]);
      if (dup.length) return;
    }

    const parsed = parseIncoming(echo); // misma estructura que un entrante

    // Buscar o crear contacto (único por negocio + canal + teléfono — R66.11)
    let rows = await query("SELECT * FROM contacts WHERE business_id = ? AND channel = 'whatsapp' AND phone = ?", [
      business.id,
      phone,
    ]);
    let contact = rows[0];
    if (!contact) {
      // En un echo no viene el perfil del cliente; intentamos el avatar igual.
      const avatar = await getProfilePicture(phone, business);
      const result = await query(
        'INSERT INTO contacts (business_id, phone, name, avatar, bot_enabled, blocked) VALUES (?, ?, ?, ?, 1, 0)',
        [business.id, phone, phone, avatar]
      );
      rows = await query('SELECT * FROM contacts WHERE id = ?', [result.insertId]);
      contact = rows[0];
    }

    // Guardar como mensaje saliente hecho a mano (desde la app)
    await query(
      `INSERT INTO messages (business_id, contact_id, role, type, content, caption, media_id, whatsapp_message_id, status, agent)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, 'delivered', ?)`,
      [business.id, contact.id, parsed.type, parsed.text, parsed.caption, parsed.mediaId, waMessageId, ECHO_AGENT]
    );

    // El dueño contestó desde la app → se considera atendido el pedido de humano.
    if (contact.needs_human) {
      await query('UPDATE contacts SET needs_human = 0 WHERE id = ?', [contact.id]).catch(() => {});
    }

    // Avisar al panel en vivo (se renderiza del lado del negocio, con la etiqueta).
    io.emit('new_message', {
      businessId: business.id,
      contactId: contact.id,
      phone: contact.phone,
      name: contact.name,
      avatar: contact.avatar,
      role: 'assistant',
      agent: ECHO_AGENT,
      type: parsed.type,
      message: parsed.text,
      mediaId: parsed.mediaId,
      status: 'delivered',
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('Error en handleEcho:', err.message);
  }
}


async function handleAppStateSync(value, business, io) {
  try {
    const items = Array.isArray(value.state_sync) ? value.state_sync : [];
    let upserted = 0;
    let skipped = 0;

    for (const item of items) {
      // Hoy solo sincronizamos contactos. Si Meta agrega más tipos de state_sync,
      // los ignoramos sin romper el webhook.
      if (item.type && item.type !== 'contact') { skipped += 1; continue; }
      const c = item.contact || {};
      const phone = c.phone_number || c.wa_id || c.phone || '';
      const name = c.full_name || c.first_name || c.profile?.name || phone;
      if (!phone) { skipped += 1; continue; }

      // action=remove significa que el contacto se borró de la agenda del celular.
      // No lo eliminamos del CRM para no perder historial; solo dejamos de tocarlo.
      if (String(item.action || 'add').toLowerCase() === 'remove') { skipped += 1; continue; }

      const contact = await findOrCreateContactForSync(business, phone, name, { touchInbound: false });
      if (contact) upserted += 1;
    }

    if (upserted || skipped) {
      console.log(`📇 smb_app_state_sync (${business.name}): ${upserted} contacto(s) sincronizado(s), ${skipped} omitido(s).`);
      io.emit('contacts_sync', { businessId: business.id, upserted, skipped });
    }
  } catch (err) {
    console.error('Error en handleAppStateSync:', err.message);
  }
}

function historyThreadsFromValue(value) {
  const threads = [];
  const batches = Array.isArray(value.history) ? value.history : [];

  for (const batch of batches) {
    // Si el negocio no autorizó compartir historial, Meta informa el error acá.
    // Lo dejamos registrado y seguimos, porque el resto de webhooks sí puede andar.
    if (Array.isArray(batch.errors) && batch.errors.length) {
      console.warn('History sync informado por Meta:', batch.errors.map((e) => e.message || e.title || e.code).join(' | '));
      continue;
    }
    if (Array.isArray(batch.threads)) {
      for (const thread of batch.threads) {
        threads.push({ id: thread.id || '', messages: Array.isArray(thread.messages) ? thread.messages : [] });
      }
    }
    // Defensa por compatibilidad: algunos wrappers/proveedores pueden enviar
    // mensajes históricos sin agrupar por threads.
    if (Array.isArray(batch.messages)) threads.push({ id: '', messages: batch.messages });
  }

  if (Array.isArray(value.messages)) threads.push({ id: '', messages: value.messages });
  return threads;
}

async function handleHistorySync(value, business, io) {
  try {
    const businessPhone = onlyDigits(value.metadata?.display_phone_number);
    const threads = historyThreadsFromValue(value);
    let imported = 0;
    let skipped = 0;

    for (const thread of threads) {
      const threadPhone = onlyDigits(thread.id);
      for (const message of thread.messages) {
        // En history, Meta indica `to` cuando el mensaje histórico fue saliente
        // desde la app del negocio. Si no hay `to`, lo tratamos como entrante.
        const outgoing = !!message.to || (businessPhone && onlyDigits(message.from) === businessPhone);
        const phone = onlyDigits(outgoing ? (message.to || threadPhone) : (message.from || threadPhone));
        if (!phone) { skipped += 1; continue; }

        const contact = await findOrCreateContactForSync(business, phone, phone, { touchInbound: !outgoing });
        if (!contact) { skipped += 1; continue; }

        const parsed = parseIncoming(message);
        const inserted = await insertSyncedMessage({
          business,
          contact,
          role: outgoing ? 'assistant' : 'user',
          parsed,
          waMessageId: message.id || message.message_id || message.meta_id || '',
          status: message.history_context?.status || (outgoing ? 'delivered' : 'delivered'),
          agent: outgoing ? HISTORY_AGENT : null,
          timestamp: parseMetaUnixTimestamp(message.timestamp),
        });
        if (inserted) imported += 1;
        else skipped += 1;
      }
    }

    if (imported || skipped) {
      console.log(`🕘 history (${business.name}): ${imported} mensaje(s) importado(s), ${skipped} omitido(s).`);
      io.emit('history_sync', { businessId: business.id, imported, skipped });
    }
  } catch (err) {
    console.error('Error en handleHistorySync:', err.message);
  }
}

// ============================================================
//  Embedded Signup (alta automática de clientes como Tech Provider)
// ------------------------------------------------------------
//  Flujo: el cliente completa el popup de Meta y nos devuelve un "code".
//  Con ese code canjeamos un token de acceso, averiguamos el número del
//  cliente (si no vino), y suscribimos nuestra app al webhook de su WABA.
//  Requiere META_APP_ID, META_APP_SECRET y META_EMBEDDED_CONFIG_ID en .env,
//  y el App Review aprobado con Advanced access. Sin eso, no funciona en vivo.
// ============================================================

// Canjea el código del Embedded Signup por un token de acceso (de negocio).
async function exchangeCode(code) {
  const { appId, appSecret } = config.whatsapp;
  if (!appId || !appSecret) throw new Error('Faltan META_APP_ID o META_APP_SECRET en el servidor');
  const r = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: { client_id: appId, client_secret: appSecret, code },
    timeout: 20000,
  });
  if (!r.data || !r.data.access_token) throw new Error('Meta no devolvió un token de acceso');
  return r.data.access_token;
}

// Devuelve el primer phone_number_id de una WABA (por si el front no lo mandó).
async function getWabaPhoneNumberId(wabaId, token) {
  const r = await axios.get(`${GRAPH}/${wabaId}/phone_numbers`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000,
  });
  const first = r.data && Array.isArray(r.data.data) ? r.data.data[0] : null;
  return first ? first.id : null;
}

// Suscribe NUESTRA app al webhook de la WABA del cliente, para recibir sus mensajes.
async function subscribeApp(wabaId, token) {
  await axios.post(`${GRAPH}/${wabaId}/subscribed_apps`, {}, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000,
  });
}

// Pide a Meta que envíe por webhook los datos de coexistencia iniciales.
// Debe llamarse dentro de las primeras 24 horas desde que el dueño conectó
// su app de WhatsApp Business al Embedded Signup de coexistencia.
async function requestBusinessAppDataSync(phoneNumberId, token, syncType) {
  if (!phoneNumberId) throw new Error('Falta phone_number_id para pedir la sincronización de coexistencia');
  if (!token) throw new Error('Falta token para pedir la sincronización de coexistencia');
  if (!SMB_SYNC_TYPES.includes(syncType)) throw new Error('sync_type inválido para coexistencia: ' + syncType);

  const r = await axios.post(
    `${GRAPH}/${phoneNumberId}/smb_app_data`,
    { messaging_product: 'whatsapp', sync_type: syncType },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return r.data;
}

// Consulta a Meta el estado real de un número: si sigue funcionando en la app de
// WhatsApp Business (is_on_biz_app=true => coexistencia) o si quedó exclusivo de
// Cloud API (is_on_biz_app=false => "chupado", ya no se puede usar en el celular).
// platform_type devuelve 'CLOUD_API' cuando el número está en la nube.
//
// Esta función es la que permite que el CRM MUESTRE el estado de cada número y el
// dueño sepa, de un vistazo, cuáles conservan la app y cuáles no. No corre sola:
// la dispara el endpoint /business/:id/whatsapp/status y el alta por coexistencia.
async function getPhoneNumberStatus(phoneNumberId, token) {
  if (!phoneNumberId) throw new Error('Falta phone_number_id para consultar el estado del número');
  if (!token) throw new Error('Falta token para consultar el estado del número');
  const r = await axios.get(`${GRAPH}/${phoneNumberId}`, {
    params: { fields: 'is_on_biz_app,platform_type' },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000,
  });
  return {
    is_on_biz_app: !!r.data?.is_on_biz_app,
    platform_type: r.data?.platform_type || '',
  };
}

// ============================================================
//  account_update — el cliente desconectó (o reconectó) su número
// ------------------------------------------------------------
//  Cuando un cliente en coexistencia se desconecta desde su app
//  (Configuración > Cuenta > Plataforma para empresas > Desconectar),
//  Meta NO permite dar de baja el número por la Deregister API: avisa por
//  webhook con event=PARTNER_REMOVED. También avisa si el número se reasocia
//  (ACCOUNT_RECONNECTED) o si se descarga por cambio de dispositivo
//  (ACCOUNT_OFFBOARDED). Acá registramos ese estado en el negocio para que el
//  panel deje de mostrarlo como conectado y el dueño se entere sin sorpresas.
// ============================================================
const DISCONNECT_EVENTS = ['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED', 'DISABLED_UPDATE', 'ACCOUNT_DELETED'];

async function handleAccountUpdate(value, business, io) {
  try {
    const event = String(value.event || '').toUpperCase();
    if (!event) return;

    if (DISCONNECT_EVENTS.includes(event)) {
      // Motivo (si Meta lo informa). PRIMARY_INACTIVITY = teléfono apagado ~14 días,
      // BUSINESS_DOWNGRADE = pasó el número al WhatsApp común, etc.
      const reason = value.disconnection_info?.reason || event;
      await query(
        'UPDATE businesses SET whatsapp_disconnected_at = NOW(), whatsapp_disconnect_reason = ? WHERE id = ?',
        [String(reason).slice(0, 60), business.id]
      );
      console.warn(`🔌 Coexistencia desconectada (${business.name}): ${event} / ${reason}`);
      io.emit('whatsapp_disconnected', { businessId: business.id, event, reason });
      return;
    }

    if (event === 'ACCOUNT_RECONNECTED') {
      // El cliente volvió a conectarse al mismo partner: limpiamos la marca de baja.
      await query(
        'UPDATE businesses SET whatsapp_disconnected_at = NULL, whatsapp_disconnect_reason = NULL WHERE id = ?',
        [business.id]
      );
      console.log(`🔌 Coexistencia reconectada (${business.name}).`);
      io.emit('whatsapp_reconnected', { businessId: business.id });
    }
  } catch (err) {
    console.error('Error en handleAccountUpdate:', err.message);
  }
}

module.exports = {
  sendText,
  sendTemplate,
  sendTemplateAnyLang,
  sendInteractiveButtons,
  sendInteractiveList,
  sendMenu,
  markAsRead,
  getProfilePicture,
  downloadMedia,
  handleIncoming,
  handleEcho,
  handleAppStateSync,
  handleHistorySync,
  handleStatus,
  exchangeCode,
  getWabaPhoneNumberId,
  subscribeApp,
  requestBusinessAppDataSync,
  getPhoneNumberStatus,
  handleAccountUpdate,
  verifySignature,
};
