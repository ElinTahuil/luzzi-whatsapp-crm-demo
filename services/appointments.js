// ============================================================
//  services/appointments.js — Turnos / agenda en MySQL
// ------------------------------------------------------------
//  Este módulo mantiene la agenda dentro de la base del CRM. Google Calendar
//  o Sheets pueden sincronizarse en el futuro, pero MySQL es la fuente de
//  verdad: el humano modifica desde el panel y el bot lee esa misma tabla.
//  Se diseñó como acción interna previa a la IA para ahorrar tokens y evitar
//  que el modelo invente horarios o estados.
// ============================================================
const { query } = require('../db');

const STATUS_LABELS = {
  pending: 'pendiente de confirmación',
  confirmed: 'confirmado',
  cancelled: 'cancelado',
  completed: 'atendido',
  rescheduled: 'reprogramado',
};

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectAppointmentIntent(text = '') {
  const t = normalizeText(text);
  if (!t) return null;
  const hasAppointmentWord = /\b(turno|turnos|cita|citas|reserva|reservas|agenda|agendar|reunion|reuniones|consulta|consultas|demo)\b/.test(t);

  // Confirmar suele llegar como respuesta corta ("sí, confirmo", "lo confirmo")
  // sin decir "turno". Se evalúa primero; si después no hay un turno para
  // confirmar, handleAppointmentIntent devuelve null y sigue el flujo normal.
  const wantsConfirm = /\b(confirmo|confirmar|confirmado|confirmada|confirmalo|confirmala|confirmamelo|confirma)\b/.test(t);
  const wordCount = t.split(' ').filter(Boolean).length;
  if (wantsConfirm && (hasAppointmentWord || wordCount <= 4)) return { type: 'confirm_request' };

  if (!hasAppointmentWord) return null;

  if (/\b(cancelar|cancelo|bajar|anular|suspender)\b/.test(t)) return { type: 'cancel_request' };
  if (/\b(reprogramar|cambiar|mover|pasar)\b/.test(t)) return { type: 'reschedule_request' };
  if (/\b(tengo|mi|mis|cuando|cuando es|horario|hora|dia|fecha|ver|consultar)\b/.test(t)) return { type: 'query' };
  if (/\b(sacar|pedir|reservar|agendar|solicitar|quiero|necesito|programar|coordinar)\b/.test(t)) return { type: 'create_request' };

  // Si habla de turnos pero la intención es ambigua, conviene consultar la agenda
  // antes de gastar IA. Si hay turnos, informa; si no, ofrece registrar solicitud.
  return { type: 'query_or_create' };
}

function detectNameSuggestion(text = '') {
  const raw = String(text || '').trim();
  const patterns = [
    /(?:^|\b)(?:soy|me llamo|mi nombre es|nombre\s*:)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'´`.-]*(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'´`.-]*){0,4})/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      const name = m[1].replace(/\s+/g, ' ').trim().replace(/[,.!?;:]+$/g, '');
      if (name.length >= 2 && name.length <= 80 && !/\d/.test(name)) return name;
    }
  }
  return '';
}

function appointmentDateLabel(row) {
  if (!row.starts_at) return 'fecha a confirmar';
  // Los turnos pueden tener solo día, sin hora exacta. En ese caso MySQL los
  // guarda a las 00:00 como convención interna y el bot debe hablar claro:
  // "horario a confirmar", no "00:00".
  const raw = String(row.starts_at).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    const day = d.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    if (!m[4] || (m[4] === '00' && m[5] === '00')) return `${day}, horario a confirmar`;
    return `${day} ${m[4]}:${m[5]}`;
  }
  const d = new Date(row.starts_at);
  if (Number.isNaN(d.getTime())) return 'fecha a confirmar';
  return d.toLocaleString('es-AR', {
    weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function formatAppointmentLine(row) {
  const service = row.service ? ` · ${row.service}` : '';
  const status = STATUS_LABELS[row.status] || row.status || 'pendiente';
  return `• ${appointmentDateLabel(row)}${service} — ${status}`;
}

async function upcomingForContact({ businessId, contactId, phone, limit = 5 }) {
  // Lee por contact_id y también por teléfono para cubrir turnos cargados
  // manualmente antes de asociarlos a una conversación.
  const params = [businessId];
  let where = 'business_id = ?';
  if (contactId) { where += ' AND (contact_id = ?'; params.push(contactId); }
  else { where += ' AND (1=0'; }
  if (phone) { where += ' OR customer_phone = ?'; params.push(phone); }
  where += ')';
  const rows = await query(
    `SELECT *,
            DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
            DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at
     FROM appointments
     WHERE ${where}
       AND status IN ('pending','confirmed','rescheduled')
       AND (starts_at IS NULL OR starts_at >= DATE_SUB(NOW(), INTERVAL 12 HOUR))
     ORDER BY (starts_at IS NULL) ASC, starts_at ASC, id DESC
     LIMIT ?`,
    [...params, Number(limit) || 5]
  );
  return rows;
}

function inferService(text = '') {
  const t = normalizeText(text);
  if (/\bdemo\b/.test(t)) return 'Demo';
  if (/\bconsulta\b/.test(t)) return 'Consulta';
  if (/\bautomatizacion|automatizaciones|bot|whatsapp|crm|ia\b/.test(t)) return 'Consulta sobre automatizaciones';
  if (/\bextraccion|analisis|estudio|laboratorio|sangre\b/.test(t)) return 'Consulta / laboratorio';
  return 'Turno solicitado por WhatsApp';
}

async function createPendingRequest({ businessId, contact, text }) {
  // Evita duplicar solicitudes si el cliente insiste varias veces en pocos minutos.
  const recent = await query(
    `SELECT id FROM appointments
     WHERE business_id = ? AND contact_id = ? AND status = 'pending'
       AND created_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR)
     ORDER BY id DESC LIMIT 1`,
    [businessId, contact.id]
  );
  if (recent.length) return { duplicated: true, id: recent[0].id };

  const result = await query(
    `INSERT INTO appointments
      (business_id, contact_id, customer_name, customer_phone, service, starts_at, ends_at, status, source, notes)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending', 'bot', ?)`,
    [
      businessId,
      contact.id,
      contact.name || contact.phone,
      contact.phone,
      inferService(text),
      `Solicitud creada automáticamente desde WhatsApp. Mensaje original: ${String(text || '').slice(0, 500)}`,
    ]
  );
  return { duplicated: false, id: result.insertId };
}

async function handleAppointmentIntent({ business, contact, text, intent }) {
  const businessId = business.id;
  const appointments = await upcomingForContact({ businessId, contactId: contact.id, phone: contact.phone, limit: 5 });
  const type = intent && intent.type;

  if (type === 'confirm_request') {
    // Confirma el turno activo más próximo del cliente (pendiente o reprogramado).
    // upcomingForContact ya ordena primero los que tienen horario.
    const toConfirm = appointments.find((a) => a.status === 'pending' || a.status === 'rescheduled');
    if (!toConfirm) return null; // nada para confirmar => sigue el flujo normal
    await query(
      "UPDATE appointments SET status = 'confirmed', updated_by = 'cliente (WhatsApp)' WHERE id = ? AND status IN ('pending','rescheduled')",
      [toConfirm.id]
    );
    return {
      source: 'turnos',
      text: `¡Listo! Confirmé tu turno:\n${formatAppointmentLine({ ...toConfirm, status: 'confirmed' })}\n\n¡Te esperamos! Si necesitás cambiarlo, escribime.`,
    };
  }

  if (type === 'query' || type === 'query_or_create') {
    if (appointments.length) {
      return {
        source: 'turnos',
        text: `Encontré estos turnos asociados a este WhatsApp:\n${appointments.map(formatAppointmentLine).join('\n')}\n\nSi necesitás cambiarlo o cancelarlo, te paso con una persona para confirmarlo.`,
      };
    }
    if (type === 'query') {
      return {
        source: 'turnos',
        text: 'No encontré turnos activos asociados a este WhatsApp. Si querés, decime qué día, horario y motivo preferís, y dejo la solicitud registrada para confirmar.',
      };
    }
  }

  if (type === 'cancel_request' || type === 'reschedule_request') {
    if (appointments.length) {
      const verb = type === 'cancel_request' ? 'cancelar' : 'reprogramar';
      return {
        source: 'turnos',
        needsHuman: true,
        text: `Encontré tu turno:\n${formatAppointmentLine(appointments[0])}\n\nPara ${verb}lo sin errores, te paso con una persona del equipo.`,
      };
    }
    return {
      source: 'turnos',
      text: 'No encontré un turno activo asociado a este WhatsApp. Decime nombre, fecha aproximada y motivo, y lo revisa una persona.',
      needsHuman: true,
    };
  }

  if (type === 'create_request' || type === 'query_or_create') {
    const r = await createPendingRequest({ businessId, contact, text });
    return {
      source: 'turnos',
      text: r.duplicated
        ? 'Ya tengo una solicitud de turno pendiente asociada a este WhatsApp. Una persona del equipo la revisa y te confirma el horario.'
        : 'Listo, dejé tu solicitud de turno registrada como pendiente. Una persona del equipo revisa disponibilidad y te confirma el horario por acá.',
    };
  }

  return null;
}

module.exports = {
  STATUS_LABELS,
  detectAppointmentIntent,
  detectNameSuggestion,
  upcomingForContact,
  handleAppointmentIntent,
  formatAppointmentLine,
};
