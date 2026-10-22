# CRM de WhatsApp (extracto de código)

Extracto de un CRM propio para atender clientes por la API oficial de WhatsApp Business, desarrollado en Node.js con Express y MySQL.

> **Esto es una muestra, no el producto completo.** Incluye solo algunos módulos para mostrar cómo trabajo. Faltan archivos que el sistema real necesita, por lo que este repositorio no se ejecuta tal cual. No contiene datos de clientes, claves ni configuración de producción.

## Qué muestra

- `services/whatsapp.js`: envío y recepción de mensajes con la API de WhatsApp Business.
- `routes/webhook.js`: webhook que recibe los mensajes entrantes.
- `services/appointments.js`: gestión de turnos.
- `services/leads.js`: alta y seguimiento de contactos.
- `routes/auth.js`, `middleware/`: inicio de sesión y medidas básicas de seguridad.
- `db.js`: acceso a MySQL.
- `.env.example`: lista de variables de entorno con valores de ejemplo.

## Tecnologías

Node.js · Express · MySQL · API de WhatsApp Business (Meta) · REST

## Aviso

El código es de mi autoría y se publica solo para que se pueda revisar. Todos los derechos reservados: no se autoriza su uso comercial ni su redistribución sin permiso.

Contacto: tahuilelin@gmail.com
