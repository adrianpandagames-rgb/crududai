import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { lookup } from 'node:dns/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = dotenv.parse(readFileSync(path.join(root, '.env')));
for (const key of ['DB_USER', 'DB_NAME']) {
  if (!source[key]) throw new Error(`Falta ${key} en .env`);
}
const appEnv = path.join(root, '.env.docker');
const mysqlEnv = path.join(root, 'docker/mysql.env');
const backup = path.join(root, 'docker/init/001-backup.sql');
if ([appEnv, mysqlEnv, backup, `${backup}.partial`].some(existsSync)) {
  throw new Error('La preparación ya existe o hay un respaldo parcial. No se sobrescriben archivos; revisa DOCKER.md.');
}
const windowsDump = 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe';
const executable = process.env.MYSQLDUMP_PATH || (existsSync(windowsDump) ? windowsDump : 'mysqldump');
const serialize = (values) => Object.entries(values).map(([key, value]) => {
  if (/[\r\n']/.test(String(value))) throw new Error(`Valor no compatible con env de Docker: ${key}`);
  return `${key}='${value}'`;
}).join('\n') + '\n';
const password = randomBytes(32).toString('hex');
const appConfig = serialize({ ...source, DB_HOST: 'db', DB_PORT: '3306',
  DB_USER: 'crud_app', DB_PASSWORD: password, TZ: 'America/Hermosillo' });
const dbConfig = serialize({ MYSQL_DATABASE: source.DB_NAME,
  MYSQL_USER: 'crud_app', MYSQL_PASSWORD: password,
  MYSQL_ROOT_PASSWORD: randomBytes(32).toString('hex'), TZ: 'America/Hermosillo' });
mkdirSync(path.dirname(backup), { recursive: true });
// Resolve like mysql2/Node (localhost may resolve to IPv6 on Windows).
const { address } = await lookup(source.DB_HOST || 'localhost');
const tempDirectory = mkdtempSync(path.join(tmpdir(), 'crud-dump-'));
const defaultsFile = path.join(tempDirectory, 'client.cnf');
const escapedPassword = (source.DB_PASSWORD || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
writeFileSync(defaultsFile, `[client]\npassword="${escapedPassword}"\n`, { mode: 0o600 });
let result;
try {
result = spawnSync(executable, [
  `--defaults-file=${defaultsFile}`, '--protocol=TCP', '--default-character-set=utf8mb4',
  `--host=${address}`,
  `--port=${source.DB_PORT || '3306'}`,
  `--user=${source.DB_USER}`,
  '--single-transaction', '--quick', '--hex-blob', '--no-tablespaces',
  '--set-gtid-purged=OFF', '--routines', '--events', '--triggers',
  `--result-file=${backup}.partial`, source.DB_NAME,
], {
  env: process.env,
  stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
});
} finally {
  rmSync(defaultsFile);
  rmdirSync(tempDirectory);
}
if (result.error || result.status !== 0) {
  throw new Error(`No se pudo exportar MySQL: ${result.error?.message || result.stderr}`);
}
renameSync(`${backup}.partial`, backup);
writeFileSync(appEnv, appConfig, { flag: 'wx', mode: 0o600 });
writeFileSync(mysqlEnv, dbConfig, { flag: 'wx', mode: 0o600 });
console.log('Respaldo completo y credenciales Docker preparados. La base original no se modificó.');
