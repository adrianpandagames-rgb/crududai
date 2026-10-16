# Despliegue en GoDaddy

Requiere Node.js 22 y MySQL. Usa GoDaddy Node.js Hosting o un VPS con Node.js; confirma que tu plan ejecuta aplicaciones Node.js. Copiar los archivos a public_html por sí solo no ejecuta Express.

## Desde GitHub

1. Sube los cambios al repositorio, incluyendo `package-lock.json`, `xlsx-0.18.5.tgz`, `src/`, `views/` y `public/`. XLSX requiere ese archivo local. Excluye `.env`, certificados, respaldos y `node_modules`.
2. Conecta el repositorio en el hosting o carga un ZIP con los archivos directamente en su raíz.
3. Donde el panel permita elegir comandos, usa instalación `npm ci --omit=dev`, build `npm run build` y arranque `npm start`. EJS no requiere compilación; build comprueba la sintaxis del servidor.
4. Configura las variables privadas del hosting:

```dotenv
NODE_ENV=production
SERVER_PROTOCOL=http
HOST=0.0.0.0
DB_HOST=servidor_mysql
DB_PORT=3306
DB_USER=usuario_mysql
DB_PASSWORD=contraseña_mysql
DB_NAME=crudnodejs
```

GoDaddy asigna `PORT`; no lo reemplaces. Habilita HTTPS para el dominio: las cookies requieren HTTPS. El servidor recibe HTTP interno y no genera certificados locales. No copies `SERVER_PROTOCOL=https` del entorno local a producción administrada.

Configura `TRUST_PROXY` con la IP o CIDR del proxy que reescribe los encabezados `X-Forwarded-*`. Solicita ese dato al proveedor si no aparece en el panel. Esto permite reconocer HTTPS y validar el origen de los formularios. No actives confianza global ni expongas directamente el puerto interno.

Agrega también las claves de los servicios utilizados indicadas en `.env.example` mediante las variables privadas del panel.

## MySQL y almacenamiento

Crea la base y restaura un respaldo completo y privado de tu base actual, incluidas las tablas y cuentas de la aplicación. Los archivos parciales de `BD/` no sustituyen un respaldo completo. No publiques respaldos en GitHub ni importes datos durante el build. Verifica conectividad y permisos CREATE/ALTER para los módulos que actualizan tablas.

Los archivos locales de `data/` y la red vial deben migrarse por separado a almacenamiento persistente. Confirma que el plan lo ofrece antes de usar importaciones. La importación vial puede requerir hasta 4 GB de heap y debe ejecutarse en un entorno con memoria suficiente y acceso a MySQL.

Usa una sola instancia: las sesiones viven en memoria y se pierden al reiniciar. El bot Python necesita un proceso separado; `npm start` no lo ejecuta. Si lo utilizas, configura su API como `https://tu-dominio` con su credencial privada.

## Alternativa VPS

Clona el repositorio, instala Node.js 22 y MySQL, crea un `.env` privado y restaura la base. Con PM2 instalado:

```sh
npm ci --omit=dev
npm run build
pm2 start ecosystem.config.cjs --env production
pm2 save
```

Configura el inicio automático de PM2 según el sistema operativo. En Nginx, dentro del servidor HTTPS con certificado válido:

```nginx
location / {
    proxy_pass http://127.0.0.1:3600;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Redirige HTTP público a HTTPS. PM2 escucha localmente y confía en el proxy local.

## Verificación

Abre el dominio por HTTPS y comprueba inicio de sesión, formularios, consultas MySQL e importaciones/exportaciones. Un error de origen al enviar formularios requiere revisar `TRUST_PROXY` y los encabezados del proxy. Si falla XLSX al instalar, verifica que el `.tgz` esté incluido.

Requisitos oficiales: https://developer.godaddy.com/en/docs/api-users/hosting/app-requirements
