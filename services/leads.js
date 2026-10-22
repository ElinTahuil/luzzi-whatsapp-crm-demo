// ============================================================
//  services/leads.js — Calificación automática de leads con IA
//  Mejora: NO llama a la IA en cada mensaje. Aplica un "debounce":
//  solo recalifica si pasó suficiente tiempo o hay mensajes nuevos.
// ============================================================
const { query } = require('../db');
const { generateJSON } = require('./gemini');
const { sendEmail } = require('./email');
const { config } = require('../config');
const { runAutomations } = require('./automations'); // Fase 3: disparar automatizaciones al calificar un lead

const MIN_USER_MESSAGES = 3; // recién calificamos con al menos 3 mensajes del usuario
const REQUALIFY_MINUTES = 30; // no recalificar más seguido que esto

async function maybeQualifyLead(contact, business, io) {
  // ¿Cuántos mensajes del usuario hay?
  const [{ total: userCount }] = await query(
    "SELECT COUNT(*) AS total FROM messages WHERE contact_id = ? AND role = 'user'",
    [contact.id]
  );
  if (userCount < MIN_USER_MESSAGES) return;

  // Última calificación
  const last = await query(
    'SELECT * FROM leads WHERE contact_id = ? ORDER BY qualified_at DESC LIMIT 1',
    [contact.id]
  );
  if (last.length) {
    const minsSince = (Date.now() - new Date(last[0].qualified_at).getTime()) / 60000;
    if (minsSince < REQUALIFY_MINUTES) return; // debounce
  }

  // Tomar el historial de texto para analizar
  const history = await query(
    "SELECT role, content FROM messages WHERE contact_id = ? AND type = 'text' ORDER BY created_at DESC LIMIT 20",
    [contact.id]
  );
  history.reverse();
  const conversationText = history.map((m) => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`).join('\n');

  const prompt = `Analizá esta conversación de WhatsApp de un negocio y clasificá al lead.

CONVERSACIÓN:
${conversationText}

Respondé SOLO con un JSON con este formato exacto, sin texto adicional:
{"score": "hot|warm|cold", "reason": "razón breve en español (máx 15 palabras)"}

Criterios:
- hot: quiere contratar/comprar, pidió precios o reunión, o quiere agendar.
- warm: muestra interés real pero todavía no quiere agendar/comprar.
- cold: sin interés real, spam, curiosidad, busca empleo.`;

  const result = await generateJSON(prompt);
  if (!result || !['hot', 'warm', 'cold'].includes(result.score)) return;

  // Evitar duplicar la misma calificación inmediatamente
  if (last.length && last[0].score === result.score) {
    const minsSince = (Date.now() - new Date(last[0].qualified_at).getTime()) / 60000;
    if (minsSince < 120) return;
  }

  await query('INSERT INTO leads (business_id, contact_id, score, reason) VALUES (?, ?, ?, ?)', [
    business.id,
    contact.id,
    result.score,
    result.reason || '',
  ]);

  io.emit('lead_qualified', {
    businessId: business.id,
    contactId: contact.id,
    phone: contact.phone,
    name: contact.name,
    score: result.score,
    reason: result.reason,
  });

  // Fase 3: disparar las automatizaciones de "lead calificado" (no bloquea ni rompe el flujo).
  runAutomations('lead_qualified', { businessId: business.id, contactId: contact.id, score: result.score })
    .catch((e) => console.error('automations lead_qualified:', e.message));

  // Aviso por email solo para leads calientes
  if (result.score === 'hot' && config.email.notify) {
    await sendEmail({
      subject: `🔥 Lead HOT (${business.name}): ${contact.name || contact.phone}`,
      html: `
        <h2>¡Nuevo lead caliente!</h2>
        <p><strong>Negocio:</strong> ${business.name}</p>
        <p><strong>Contacto:</strong> ${contact.name || 'Sin nombre'}</p>
        <p><strong>Teléfono:</strong> ${contact.phone}</p>
        <p><strong>Razón:</strong> ${result.reason || '-'}</p>
        <p><strong>Fecha:</strong> ${new Date().toLocaleString('es-AR')}</p>
        <br>
        <a href="${config.appUrl}/conversations">Ver conversación →</a>
      `,
    });
  }
}

module.exports = { maybeQualifyLead };
