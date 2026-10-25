# Aplicación y MySQL en Docker

La configuración ejecuta Node.js 22 y MySQL 8.0.46, con volúmenes persistentes
para la base y los certificados. MySQL no publica puertos hacia Windows.

## Preparar e iniciar

1. Instala y abre [Docker Desktop para Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
   con WSL 2 y contenedores Linux.
2. Con tu MySQL actual iniciado y las credenciales de `.env`, prepara la copia:

   ```powershell
   node scripts/prepare-docker.js
   ```

   Si ya se preparó correctamente, omite este paso. Genera un respaldo completo
   en `docker/init/001-backup.sql`, la configuración de la aplicación en
   `.env.docker` y credenciales nuevas en `docker/mysql.env`. Los tres archivos
   están ignorados por Git y excluidos de la imagen. La base original no cambia.
   Se requiere `mysqldump`; se detecta MySQL Server 8.0 en Windows o puedes
   indicar el ejecutable con la variable `MYSQLDUMP_PATH`.
3. Inicia ambos servicios:

   ```powershell
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 db app
   ```

Abre **https://localhost:3444** con tus usuarios actuales. El navegador muestra
una advertencia por el certificado autofirmado; acepta la excepción para uso
local. El puerto 3444 permite mantener la aplicación anterior en 3443.
El acceso se publica solamente en esta computadora.

MySQL importa el respaldo **solo cuando su volumen está vacío**. La aplicación
espera a que termine la inicialización. No reemplaces el respaldo con los SQL
de `BD`: no contienen el esquema completo y algunos eliminan tablas.

Comprueba la conexión y las tablas:

```powershell
docker compose exec app node --input-type=module -e "import pool from './src/db.js'; const [rows] = await pool.query('SHOW TABLES'); console.log('Tablas:', rows.length); await pool.end();"
```

Comprueba también el inicio de sesión y los registros. El healthcheck de la
aplicación verifica HTTPS, no todas las funciones del sistema.

## Uso posterior

```powershell
# Reconstruir tras modificar código
docker compose up -d --build
# Detener conservando datos
docker compose down
# Volver a iniciar
docker compose up -d
```

No uses `docker compose down -v` si quieres conservar los datos: elimina los
volúmenes. Las sesiones están en memoria y se pierden al reiniciar la aplicación.
Las modificaciones en Docker y en MySQL original son independientes y no se
sincronizan. Para el cambio definitivo, deja de capturar en la versión anterior
y prepara un respaldo actualizado antes de la primera importación.

El script no sobrescribe archivos. Para repetir la preparación, conserva una
copia segura de los tres archivos generados y retíralos de sus rutas originales.
Un archivo `001-backup.sql.partial` indica una exportación fallida; revisa el
error y retira ese archivo antes de volver a intentar. Cambiar el respaldo o las
credenciales de los archivos no modifica un volumen ya inicializado.

Incluye `package-lock.json` y `xlsx-0.20.3.tgz` al trasladar o versionar el
proyecto: `npm ci` necesita ambos. Conserva también, de forma privada, los tres
archivos generados al trasladar esta instalación. Las dependencias nativas se
instalan dentro de Linux; no se copia `node_modules` de Windows.
