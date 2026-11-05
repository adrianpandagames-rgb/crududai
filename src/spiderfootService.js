// Runs SpiderFoot for one target (domain, IP, network, ASN, e-mail, phone, username, name or Bitcoin address)
// and turns the events it prints into rows grouped by kind.
import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidUsername, normalizeUsername } from './maigretService.js';
import { isValidCountryCode, isValidEmail, isValidPhone, normalizeCountryCode, normalizeEmail, normalizePhone } from './osintTools.js';

// `targetType` is SpiderFoot's own name for the kind of target; tools/spiderfoot_scan.py passes it on.
export const SPIDERFOOT_TYPES = {
  dominio: { label: 'Dominio', placeholder: 'ej. ejemplo.com.mx', hint: 'Subdominios, IPs, correos, certificados, tecnologías, filtraciones y más.' },
  ip: { label: 'IP', placeholder: 'ej. 189.203.10.5', hint: 'IPv4 o IPv6: ubicación, proveedor, puertos conocidos, listas negras y sitios en la misma IP.' },
  red: { label: 'Red', placeholder: 'ej. 189.203.10.0/24', hint: 'Un bloque de IPs en notación CIDR, de /16 a /32 (IPv6: de /32 a /128).' },
  asn: { label: 'ASN', placeholder: 'ej. AS8151', hint: 'Número de sistema autónomo: los bloques de IPs y los dominios de esa organización.' },
  correo: { label: 'Correo', placeholder: 'ej. nombre@gmail.com', hint: 'Filtraciones, cuentas asociadas, dominio y reputación del correo.' },
  telefono: { label: 'Teléfono', placeholder: 'ej. 6621234567', hint: 'Compañía, tipo de línea y menciones públicas del número.' },
  usuario: { label: 'Usuario', placeholder: 'ej. guero_hmo', hint: 'Cuentas con ese nombre en más de 500 sitios, más lo que se encuentre en ellas.' },
  nombre: { label: 'Nombre', placeholder: 'ej. Juan Pérez López', hint: 'Menciones de la persona en buscadores, redes y fuentes públicas. Usa nombre y apellido.' },
  bitcoin: { label: 'Bitcoin', placeholder: 'ej. bc1q…', hint: 'Saldo, transacciones y si la dirección aparece en listas de abuso.' },
};

// SpiderFoot picks the modules by use case. "Passive" never contacts the target itself; "all" also runs the active
// modules (port scans, crawling the target's sites, guessing subdomains). A search that hits its time limit keeps
// what it found so far.
export const SPIDERFOOT_MODES = {
  rapida: { label: 'Rápida (pasiva, hasta 15 minutos)', limit: '15 minutos', args: ['-u', 'passive'], timeoutMs: 15 * 60 * 1000 },
  normal: { label: 'Normal (pasiva, hasta 1 hora)', limit: '1 hora', args: ['-u', 'passive'], timeoutMs: 60 * 60 * 1000 },
  completa: { label: 'Completa (activa, hasta 3 horas)', limit: '3 horas', args: ['-u', 'all'], timeoutMs: 3 * 60 * 60 * 1000 },
};

export const STOP_REASON = 'detener';
const LOG_TAIL_LENGTH = 4000;
const MAX_EVENTS = 8000;
const MAX_DATA_LENGTH = 1500;
const MAX_TOTAL_DATA = 6 * 1024 * 1024;
const SCAN_SCRIPT = fileURLToPath(new URL('../tools/spiderfoot_scan.py', import.meta.url));

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
const BITCOIN = /^(bc(0([ac-hj-np-z02-9]{39}|[ac-hj-np-z02-9]{59})|1[ac-hj-np-z02-9]{8,87})|[13][a-km-zA-HJ-NP-Z1-9]{25,35})$/;
const HUMAN_NAME = /^[\p{L}][\p{L}'.-]*(?: [\p{L}][\p{L}'.-]*)+$/u;

// Checks what the person typed and returns what SpiderFoot receives, or an error to show them.
// Nothing returned here can start with a dash, so it is never read as a SpiderFoot option.
export function parseTarget(type, body = {}) {
  const value = String(body.objetivo ?? '').trim();
  if (type === 'dominio') {
    const host = value.toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
    return HOSTNAME.test(host) ? { target: host, targetType: 'INTERNET_NAME' }
      : { error: 'Ingresa un dominio válido, por ejemplo ejemplo.com.mx.' };
  }
  if (type === 'ip') {
    const version = net.isIP(value);
    if (version === 4) return { target: value, targetType: 'IP_ADDRESS' };
    if (version === 6) return { target: value.toLowerCase(), targetType: 'IPV6_ADDRESS' };
    return { error: 'Ingresa una dirección IP válida, por ejemplo 189.203.10.5.' };
  }
  if (type === 'red') {
    const [address, prefixText, extra] = value.toLowerCase().split('/');
    const prefix = /^\d{1,3}$/.test(prefixText ?? '') ? Number(prefixText) : NaN;
    if (extra === undefined && net.isIPv4(address) && prefix >= 16 && prefix <= 32) return { target: `${address}/${prefix}`, targetType: 'NETBLOCK_OWNER' };
    if (extra === undefined && net.isIPv6(address) && prefix >= 32 && prefix <= 128) return { target: `${address}/${prefix}`, targetType: 'NETBLOCKV6_OWNER' };
    return { error: 'Ingresa la red en notación CIDR, por ejemplo 189.203.10.0/24 (de /16 a /32).' };
  }
  if (type === 'asn') {
    const asn = value.toUpperCase().replace(/^AS\s*/, '');
    return /^[1-9]\d{0,9}$/.test(asn) && Number(asn) <= 4294967295 ? { target: asn, targetType: 'BGP_AS_OWNER', shown: `AS${asn}` }
      : { error: 'Ingresa el número de sistema autónomo, por ejemplo AS8151 u 8151.' };
  }
  if (type === 'correo') {
    const email = normalizeEmail(value);
    return isValidEmail(email) ? { target: email, targetType: 'EMAILADDR' } : { error: 'Ingresa un correo válido, por ejemplo nombre@dominio.com.' };
  }
  if (type === 'telefono') {
    const countryCode = normalizeCountryCode(body.lada);
    const phone = normalizePhone(body.telefono);
    if (!isValidCountryCode(countryCode)) return { error: 'Ingresa la clave de país, por ejemplo 52 para México.' };
    if (!isValidPhone(phone)) return { error: 'Ingresa el teléfono sin la clave de país: de 6 a 14 dígitos.' };
    return { target: `+${countryCode}${phone}`, targetType: 'PHONE_NUMBER', shown: `+${countryCode} ${phone}` };
  }
  if (type === 'usuario') {
    const username = normalizeUsername(value);
    return isValidUsername(username) ? { target: username, targetType: 'USERNAME', shown: `@${username}` }
      : { error: 'Ingresa un nombre de usuario de hasta 64 caracteres: letras, números, punto, guion o guion bajo, sin espacios.' };
  }
  if (type === 'nombre') {
    const name = value.replace(/\s+/g, ' ');
    return name.length <= 100 && HUMAN_NAME.test(name) ? { target: name, targetType: 'HUMAN_NAME' }
      : { error: 'Ingresa nombre y apellido, solo con letras y espacios, por ejemplo Juan Pérez López.' };
  }
  if (type === 'bitcoin') {
    return BITCOIN.test(value) ? { target: value, targetType: 'BITCOIN_ADDRESS' } : { error: 'Ingresa una dirección de Bitcoin válida.' };
  }
  return { error: 'Tipo de búsqueda no válido.' };
}

// The bot receives a single line of text, so the kind of target is guessed when the person does not give it.
// "juan.perez" reads as a domain: to search it as a username, write @juan.perez or give the type.
export function detectTargetType(text) {
  const value = String(text ?? '').trim();
  if (/^[a-z]+:\/\//i.test(value)) return 'dominio';
  if (/^\+\d/.test(value)) return 'telefono';
  if (value.startsWith('@')) return 'usuario';
  if (value.includes('@')) return 'correo';
  if (value.includes('/')) return 'red';
  if (net.isIP(value)) return 'ip';
  if (/^AS\s?\d+$/i.test(value)) return 'asn';
  if (BITCOIN.test(value)) return 'bitcoin';
  if (/\s/.test(value)) return 'nombre';
  if (value.includes('.')) return 'dominio';
  return 'usuario';
}

// Same checks as the web form, from one line of text: a phone is written "+52 6621234567".
export function parseTextTarget(text, type = detectTargetType(text)) {
  if (!Object.hasOwn(SPIDERFOOT_TYPES, type)) return { type, error: 'Tipo de búsqueda no válido.' };
  if (type === 'telefono') {
    const match = /^\+?(\d{1,3})[\s-]+(\d[\d\s-]*)$/.exec(String(text ?? '').trim());
    if (!match) return { type, error: 'Escribe el teléfono con la clave de país separada, por ejemplo +52 6621234567.' };
    return { type, ...parseTarget(type, { lada: match[1], telefono: match[2] }) };
  }
  return { type, ...parseTarget(type, { objetivo: text }) };
}

export const buildSpiderfootArgs =({ target, mode }) => [
  SCAN_SCRIPT, '-s', target, ...SPIDERFOOT_MODES[mode].args, '-o', 'json', '-q', '-max-threads', '4',
];

// ---- What SpiderFoot found ---------------------------------------------------------------------

export const EVENT_CATEGORIES = {
  personas: 'Personas, cuentas y contacto',
  riesgos: 'Filtraciones y riesgos',
  infraestructura: 'Infraestructura',
  afiliados: 'Relacionados (afiliados)',
  otros: 'Otros datos',
  crudos: 'Datos sin procesar',
};

const TYPE_LABELS = {
  'Account on External Site': 'Cuenta en otro sitio',
  'Hacked Account on External Site': 'Cuenta filtrada en otro sitio',
  'Hacked Email Address': 'Correo en filtraciones',
  'Hacked User Account on External Site': 'Cuenta de usuario filtrada',
  'Social Media Presence': 'Presencia en redes sociales',
  'Human Name': 'Nombre de persona',
  'Username': 'Nombre de usuario',
  'Email Address': 'Correo electrónico',
  'Email Gateway (DNS \'MX\' Records)': 'Servidor de correo (MX)',
  'Phone Number': 'Teléfono',
  'Phone Number Compromised': 'Teléfono en filtraciones',
  'Phone Number Type': 'Tipo de línea',
  'Physical Address': 'Dirección física',
  'Physical Location': 'Ubicación',
  'Physical Coordinates': 'Coordenadas',
  'Country Name': 'País',
  'Company Name': 'Empresa',
  'Job Title': 'Puesto',
  'Date of Birth': 'Fecha de nacimiento',
  'PGP Public Key': 'Llave PGP pública',
  'Leak Site URL': 'URL en sitio de filtraciones',
  'Leak Site Content': 'Contenido en sitio de filtraciones',
  'Darknet Mention URL': 'Mención en la dark web',
  'Darknet Mention Web Content': 'Contenido en la dark web',
  'Password': 'Contraseña',
  'Compromised Password': 'Contraseña comprometida',
  'Compromised Password Hash': 'Hash de contraseña comprometida',
  'IP Address': 'Dirección IP',
  'IPv6 Address': 'Dirección IPv6',
  'Internet Name': 'Nombre de host',
  'Internet Name - Unresolved': 'Nombre de host sin resolver',
  'Domain Name': 'Dominio',
  'Domain Name (Parent)': 'Dominio padre',
  'Domain Registrar': 'Registrador del dominio',
  'Domain Whois': 'WHOIS del dominio',
  'Similar Domain': 'Dominio parecido',
  'Co-Hosted Site': 'Sitio en el mismo servidor',
  'Co-Hosted Site - Domain Name': 'Dominio en el mismo servidor',
  'Netblock Ownership': 'Bloque de IPs propio',
  'Netblock Membership': 'Bloque de IPs al que pertenece',
  'Netblock Whois': 'WHOIS del bloque de IPs',
  'Netblock IPv6 Ownership': 'Bloque de IPv6 propio',
  'Netblock IPv6 Membership': 'Bloque de IPv6 al que pertenece',
  'Malicious IP on Owned Netblock': 'IP maliciosa en un bloque propio',
  'Blacklisted Co-Hosted Site': 'Sitio del mismo servidor en listas negras',
  'BGP AS Ownership': 'Sistema autónomo propio',
  'BGP AS Membership': 'Sistema autónomo al que pertenece',
  'Open TCP Port': 'Puerto TCP abierto',
  'Open TCP Port Banner': 'Banner de puerto TCP',
  'Open UDP Port': 'Puerto UDP abierto',
  'Operating System': 'Sistema operativo',
  'Software Used': 'Software usado',
  'Web Technology': 'Tecnología web',
  'Web Server': 'Servidor web',
  'Hosting Provider': 'Proveedor de hosting',
  'Cloud Storage Bucket': 'Almacenamiento en la nube',
  'Cloud Storage Bucket Open': 'Almacenamiento en la nube abierto',
  'SSL Certificate - Raw Data': 'Certificado SSL (crudo)',
  'SSL Certificate Expired': 'Certificado SSL vencido',
  'SSL Certificate Expiring': 'Certificado SSL por vencer',
  'SSL Certificate Host Mismatch': 'Certificado SSL de otro host',
  'Linked URL - Internal': 'Enlace interno',
  'Linked URL - External': 'Enlace externo',
  'Web Analytics': 'ID de analítica web',
  'Description - Category': 'Categoría del sitio',
  'Description - Abstract': 'Descripción',
  'Search Engine Web Content': 'Resultado en buscadores',
  'Public Code Repository': 'Repositorio de código público',
  'Bitcoin Address': 'Dirección de Bitcoin',
  'Bitcoin Balance': 'Saldo de Bitcoin',
  'Ethereum Address': 'Dirección de Ethereum',
  'Raw Data from RIRs/APIs': 'Respuesta cruda de registros o APIs',
  'Raw DNS Records': 'Registros DNS crudos',
  'Raw File Meta Data': 'Metadatos crudos de archivos',
  'DNS SPF Record': 'Registro SPF',
  'DNS TXT Record': 'Registro TXT',
  'Malicious IP Address': 'IP maliciosa',
  'Malicious Internet Name': 'Host malicioso',
  'Malicious E-mail Address': 'Correo malicioso',
  'Blacklisted IP Address': 'IP en listas negras',
  'Blacklisted Internet Name': 'Host en listas negras',
  'Vulnerability - CVE Critical': 'Vulnerabilidad crítica (CVE)',
  'Vulnerability - CVE High': 'Vulnerabilidad alta (CVE)',
  'Vulnerability - CVE Medium': 'Vulnerabilidad media (CVE)',
  'Vulnerability - CVE Low': 'Vulnerabilidad baja (CVE)',
};

// The category comes from SpiderFoot's (English) description of the event type; unknown types keep that description.
export function describeEventType(type) {
  const affiliate = /^Affiliate - /.test(type);
  const base = affiliate ? type.replace(/^Affiliate - /, '') : type;
  const label = affiliate ? `Relacionado: ${TYPE_LABELS[base] || base}` : TYPE_LABELS[type] || type;
  let category = 'otros';
  if (affiliate) category = 'afiliados';
  // Case-sensitive on purpose: "IP" must not match "Description".
  else if (/^Raw |Whois|Meta Data|HTTP Headers|Page Content/.test(type)) category = 'crudos';
  else if (/Hacked|Leak|Darknet|Malicious|Blacklisted|Vulnerab|Password|Compromised|Breach|Defaced|Abuse/.test(type)) category = 'riesgos';
  else if (/Name|Account|Social|Email|Phone|Physical|Country|Company|Job|Birth|PGP|Bitcoin|Ethereum/.test(type)
    && !/Domain Name|Internet Name|Gateway/.test(type)) category = 'personas';
  else if (/\bIP|Domain|Internet Name|Netblock|BGP|Port|DNS|SSL|Certificate|Web|URL|Hosting|Cloud|Software|Operating|Banner|Registrar|Co-Hosted|Server/.test(type)) {
    category = 'infraestructura';
  }
  return { label, category };
}

// sf.py prints a JSON array one event per line ("[{...},", "{...},", "{...}]"). A search stopped early leaves the
// array open and maybe a cut-off last line, so each line is read on its own and broken ones are skipped.
export function parseSpiderfootOutput(text) {
  const events = [];
  const seen = new Set();
  let budget = MAX_TOTAL_DATA;
  let dropped = 0;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim().replace(/^\[/, '').replace(/[,\]]+$/, '');
    if (!line.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    // "SpiderFoot UI" events are the target itself.
    if (!event || event.module === 'SpiderFoot UI') continue;
    const type = String(event.type ?? '').trim();
    // In JSON, sf.py leaves the <SFURL> tags its modules wrap URLs in.
    const data = String(event.data ?? '').replace(/<\/?SFURL>/g, '').trim();
    if (!type || !data) continue;
    const key = `${type}\u0000${data}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (events.length >= MAX_EVENTS || budget <= 0) { dropped++; continue; }
    const value = data.slice(0, MAX_DATA_LENGTH);
    budget -= value.length;
    events.push({
      type,
      data: value,
      module: String(event.module ?? '').replace(/^sfp_/, ''),
      source: String(event.source ?? '').slice(0, 300),
    });
  }
  return { events, dropped };
}

const appendTail = (tail, chunk) => (tail + chunk).slice(-LOG_TAIL_LENGTH);
const lastLines = (log) => log.trim().split('\n').slice(-3).join(' ').slice(0, 300);

// SpiderFoot runs the scan in a child process, so the whole process group is stopped, not just sf.py.
export async function runSpiderfoot({
  target, targetType, mode, signal,
  python = process.env.SPIDERFOOT_PYTHON || '/opt/spiderfoot/venv/bin/python',
  dir = process.env.SPIDERFOOT_DIR || '/opt/spiderfoot',
}) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'spiderfoot-'));
  const outputPath = path.join(workDir, 'eventos.json');
  const output = await open(outputPath, 'w');
  let timedOut = false;
  try {
    let log = '';
    const exitCode = await new Promise((resolve, reject) => {
      const groupKill = process.platform !== 'win32';
      const child = spawn(python, buildSpiderfootArgs({ target, mode }), {
        cwd: workDir,
        env: {
          ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
          SPIDERFOOT_DIR: dir, SPIDERFOOT_TARGET_TYPE: targetType,
          // A fresh database per search; the cache of public lists is shared between searches.
          SPIDERFOOT_DATA: path.join(workDir, 'datos'),
          SPIDERFOOT_CACHE: process.env.SPIDERFOOT_CACHE || path.join(os.tmpdir(), 'spiderfoot-cache'),
        },
        stdio: ['ignore', output.fd, 'pipe'],
        detached: groupKill,
        windowsHide: true,
      });
      const stop = () => {
        try {
          if (groupKill) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* already finished */ }
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, SPIDERFOOT_MODES[mode].timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      child.stderr.on('data', (chunk) => { log = appendTail(log, chunk.toString('utf8')); });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error.code === 'ENOENT' ? new Error('SpiderFoot no está instalado en el servidor.') : error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve(code);
      });
    });
    const stopped = Boolean(signal?.aborted);
    if (stopped && signal.reason !== STOP_REASON) throw new Error('La búsqueda fue cancelada.');
    await output.close().catch(() => {});
    const { events, dropped } = parseSpiderfootOutput(await readFile(outputPath, 'utf8'));
    if (events.length === 0 && exitCode !== 0 && !timedOut && !stopped) {
      throw new Error(`SpiderFoot no pudo completar la búsqueda. ${lastLines(log)}`.trim().slice(0, 500));
    }
    const notes = [];
    if (timedOut) notes.push('La búsqueda llegó a su tiempo máximo; se guardó lo encontrado hasta ese momento.');
    if (stopped) notes.push('La búsqueda se detuvo a petición; se guardó lo encontrado hasta ese momento.');
    if (dropped) notes.push(`Se omitieron ${dropped} resultado(s) adicionales para no exceder el tamaño máximo guardado.`);
    return { events, notes, partial: timedOut || stopped };
  } finally {
    await output.close().catch(() => {});
    await rm(workDir, { recursive: true, force: true });
  }
}
