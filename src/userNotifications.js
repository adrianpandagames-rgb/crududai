import nodemailer from 'nodemailer';

const messages = {
  created: ['Cuenta creada', 'Se ha creado tu cuenta. Usa la contraseña temporal indicada abajo y cámbiala al iniciar sesión.'],
  reset: ['Contraseña restablecida', 'Un administrador ha restablecido tu contraseña. Usa la contraseña temporal indicada abajo y cámbiala al iniciar sesión.'],
  changed: ['Contraseña actualizada', 'La contraseña de tu cuenta se ha cambiado correctamente. Si no reconoces este cambio, contacta de inmediato al administrador.'],
};

export function createUserNotifier({ env = process.env, createTransport = nodemailer.createTransport, logger = console } = {}) {
  let transport;
  return async function notifyUser(email, event, { temporaryPassword } = {}) {
    try {
      if (!messages[event]) throw new Error('Invalid notification event');
      const includesPassword = event === 'created' || event === 'reset';
      if (includesPassword && !temporaryPassword) throw new Error('Missing temporary password');
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
      const [subject, text] = messages[event];
      const result = await transport.sendMail({
        from: env.SMTP_FROM,
        to: { address: email },
        subject,
        text: `${text}\n\nCuenta: ${email}${includesPassword ? `\nContraseña temporal: ${temporaryPassword}` : ''}`,
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
