import nodemailer from 'nodemailer';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { AUDIT_TIME_ZONE } from './auditFilters.js';

const SISTEMA = 'Unidad de Análisis e Inteligencia';
const LOGO_CID = 'logo@udai';
const LOGO_PATH = fileURLToPath(new URL('../public/imgs/logo.png', import.meta.url));

// Each event: subject, opening paragraph, and the highlighted value it carries, if any.
const messages = {
  created: {
    subject: 'Tu cuenta fue creada',
    title: 'Bienvenido',
    text: 'Se creó tu cuenta. Entra con la contraseña temporal de abajo y cámbiala al iniciar sesión; después registra tu dispositivo.',
    highlight: ({ temporaryPassword }) => ['Contraseña temporal', temporaryPassword],
    button: 'Iniciar sesión',
  },
  reset: {
    subject: 'Tu contraseña fue restablecida',
    title: 'Contraseña restablecida',
    text: 'Un administrador restableció tu contraseña. Entra con la contraseña temporal de abajo y cámbiala al iniciar sesión.',
    highlight: ({ temporaryPassword }) => ['Contraseña temporal', temporaryPassword],
    button: 'Iniciar sesión',
  },
  changed: {
    subject: 'Tu contraseña fue cambiada',
    title: 'Contraseña actualizada',
    text: 'La contraseña de tu cuenta se cambió correctamente.',
    warning: 'Si no reconoces este cambio, contacta de inmediato al administrador.',
  },
  codigo: {
    subject: 'Tu código para iniciar sesión',
    title: 'Código de verificación',
    text: 'Alguien escribió tu contraseña y pidió este código para terminar de iniciar sesión.',
    highlight: ({ codigo }) => ['Código', codigo],
    note: ({ minutos }) => `Vence en ${minutos} minutos y sirve una sola vez. Nadie del equipo te lo pedirá nunca.`,
    warning: 'Si no fuiste tú, no compartas el código y cambia tu contraseña de inmediato: alguien la conoce.',
  },
};

const required = { created: ['temporaryPassword'], reset: ['temporaryPassword'], codigo: ['codigo', 'minutos'] };

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fechaSonora = (date) => new Intl.DateTimeFormat('es-MX', {
  timeZone: AUDIT_TIME_ZONE, dateStyle: 'long', timeStyle: 'short',
}).format(date);

// A plain table layout with inline styles, which is what mail clients (Gmail, Outlook) render reliably.
// The same content also goes as plain text for clients that do not show HTML.
export function buildEmail(event, email, data = {}, { baseUrl = '', now = new Date(), withLogo = false } = {}) {
  const m = messages[event];
  const highlight = m.highlight?.(data);
  const note = m.note?.(data);
  const details = [['Cuenta', email], ['Fecha', fechaSonora(now)], ...(data.ip ? [['Dirección IP', data.ip]] : [])];
  const link = m.button && /^https:\/\//.test(baseUrl) ? baseUrl.replace(/\/+$/, '') + '/' : null;

  const text = [
    m.title, '', m.text,
    ...(highlight ? ['', `${highlight[0]}: ${highlight[1]}`] : []),
    ...(note ? ['', note] : []),
    ...(m.warning ? ['', m.warning] : []),
    '', ...details.map(([k, v]) => `${k}: ${v}`),
    ...(link ? ['', `${m.button}: ${link}`] : []),
    '', '—', `${SISTEMA}. Correo automático, no respondas a este mensaje.`,
  ].join('\n');

  const fila = (html) => `<tr><td style="padding:0 32px">${html}</td></tr>`;
  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(m.subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f4;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(m.text)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f4;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #dde3ea">
<tr><td style="background:#14532d;padding:20px 32px" align="left">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
${withLogo ? `<td style="padding-right:12px"><img src="cid:${LOGO_CID}" width="44" height="44" alt="" style="display:block;border-radius:50%;background:#ffffff"></td>` : ''}
<td style="color:#ffffff;font-size:15px;font-weight:600;letter-spacing:.3px">${escapeHtml(SISTEMA.toUpperCase())}</td>
</tr></table></td></tr>
<tr><td style="height:28px"></td></tr>
${fila(`<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#14532d">${escapeHtml(m.title)}</h1>`)}
${fila(`<p style="margin:0 0 20px;font-size:15px;line-height:1.6">${escapeHtml(m.text)}</p>`)}
${highlight ? fila(`<div style="margin:0 0 20px;padding:18px;border-radius:10px;background:#f0fdf4;border:1px solid #bbf7d0;text-align:center">
<div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#4b5563;margin-bottom:6px">${escapeHtml(highlight[0])}</div>
<div style="font-family:Consolas,Menlo,monospace;font-size:${event === 'codigo' ? '34px;letter-spacing:8px' : '20px;letter-spacing:1px'};font-weight:700;color:#14532d;word-break:break-all">${escapeHtml(highlight[1])}</div>
</div>`) : ''}
${note ? fila(`<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#4b5563">${escapeHtml(note)}</p>`) : ''}
${link ? fila(`<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#15803d;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">${escapeHtml(m.button)}</a></p>`) : ''}
${m.warning ? fila(`<p style="margin:0 0 20px;padding:12px 14px;border-left:4px solid #dc2626;background:#fef2f2;font-size:14px;line-height:1.5;color:#7f1d1d">${escapeHtml(m.warning)}</p>`) : ''}
${fila(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#4b5563;border-top:1px solid #e5e7eb">
${details.map(([k, v]) => `<tr><td style="padding:8px 0 0;width:110px;vertical-align:top">${escapeHtml(k)}</td><td style="padding:8px 0 0;color:#1f2933">${escapeHtml(v)}</td></tr>`).join('')}
</table>`)}
<tr><td style="height:28px"></td></tr>
<tr><td style="background:#f8fafc;padding:16px 32px;font-size:12px;line-height:1.5;color:#6b7280;border-top:1px solid #e5e7eb">
Correo automático de ${escapeHtml(SISTEMA)}. No respondas a este mensaje.</td></tr>
</table></td></tr></table></body></html>`;

  return { subject: m.subject, text, html };
}

let logoPromise = null;
const defaultLoadLogo = () => {
  logoPromise ??= sharp(LOGO_PATH).resize(88, 88).png().toBuffer().catch(() => null);
  return logoPromise;
};

export function createUserNotifier({
  env = process.env, createTransport = nodemailer.createTransport, logger = console, loadLogo = defaultLoadLogo,
} = {}) {
  let transport;
  // data: temporaryPassword (created, reset), codigo and minutos (codigo), and optionally ip.
  return async function notifyUser(email, event, data = {}) {
    try {
      if (!messages[event]) throw new Error('Invalid notification event');
      if ((required[event] || []).some((key) => !data[key])) throw new Error('Missing notification data');
      if (!env.SMTP_HOST || !env.SMTP_FROM) {
        return { sent: false, warning: 'No se envió el correo: falta configurar SMTP.' };
      }
      const port = Number(env.SMTP_PORT || 587);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP port');
      if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) throw new Error('Incomplete SMTP credentials');
      transport ??= createTransport({
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        requireTLS: port !== 465,
        ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
      });
      const logo = await loadLogo();
      const { subject, text, html } = buildEmail(event, email, data, { baseUrl: env.PUBLIC_BASE_URL || '', withLogo: Boolean(logo) });
      const result = await transport.sendMail({
        from: env.SMTP_FROM,
        to: { address: email },
        subject,
        text,
        html,
        // The logo travels inside the message, so it shows even where remote images are blocked.
        attachments: logo ? [{ filename: 'logo.png', content: logo, contentType: 'image/png', cid: LOGO_CID }] : [],
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP recipient rejected');
      return { sent: true, warning: null };
    } catch {
      logger.error('No se pudo enviar la notificación de usuario por SMTP.');
      return { sent: false, warning: 'La operación se completó, pero no se pudo enviar el correo. Contacta al administrador.' };
    }
  };
}

export const notifyUser = createUserNotifier();
