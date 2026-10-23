# Bot de consultas mediante API

### Reinicio automático al guardar un rol en Hostinger

Al guardar un rol en Usuarios, Node solicita a PM2 reiniciar `crududai-telegram`.
Cuando PM2 confirma el reinicio se muestra el toast **Bot actualizado** y se escribe
la confirmación en los logs de Node. Esto confirma el reinicio del proceso;
la conexión posterior con Telegram se revisa en los logs del bot.
Si falla, el rol permanece guardado y la página muestra un aviso de error.

Preparación única en el VPS, desde la raíz del proyecto y con la misma cuenta Linux
que administra el PM2 de Node (Python 3.10 o posterior y PM2 deben estar instalados):

```bash
python3 -m venv .venv-telegram
.venv-telegram/bin/python -m pip install -r telegram_bot/requirements.txt
pm2 start ecosystem.telegram.config.cjs
pm2 save
pm2 logs crududai-telegram --lines 30
```

Antes de iniciar este proceso, detén la instancia anterior del bot si ya existe:
solo debe ejecutarse una instancia por token. Conserva el `.env` configurado con
el token del bot y la conexión a la API. Si el bot ya está administrado por PM2,
puedes conservarlo y poner su nombre en `TELEGRAM_BOT_PM2_NAME` en `.env`.
No uses el nombre del proceso web `crududai`. Si PM2 no está en el PATH de Node,
configura `PM2_EXECUTABLE` con la ruta absoluta que devuelve `command -v pm2`.
Después de cambiar estas variables, reinicia Node con
`pm2 restart crududai --update-env`. El reinicio automático se aplica a **Guardar rol**.

### Búsqueda de nombres de usuario con Maigret

```text
/maigret guero_hmo
/maigret guero_hmo --normal
```

Busca el nombre de usuario en 100 sitios públicos (o 500 con `--normal`) y sigue los alias que encuentre. La búsqueda entra en la misma cola que la pestaña Maigret del sistema, a nombre del usuario vinculado y con sus mismas reglas de grupo, así que también aparece en la web. El bot avisa que quedó en cola y, al terminar, envía las cuentas encontradas, el reporte HTML y la liga al detalle (usa `PUBLIC_BASE_URL`). Cada usuario puede tener dos búsquedas en curso. Si el bot se reinicia mientras espera, el resultado sigue disponible en la web.

### Imagen de cobertura de una antena

```text
/cobertura 29.0729 -110.9559 50
/cobertura 29.0729 -110.9559 50 1000
/cobertura 29.0729 -110.9559
/cobertura 29°4'19.2"N, 110°57'21.6"W 50
/cobertura 29.0729 -110.9559 --alcance 1000
```

Los argumentos obligatorios son latitud y longitud: acepta decimal o DMS con hemisferios N/S y E/W/O, y convierte DMS a decimal. Azimut y alcance son opcionales. Sin azimut muestra únicamente la antena; con azimut muestra un sector de ±45°. El alcance predeterminado es 500 m (máximo 10000). Para indicar alcance sin azimut usa `--alcance 1000`; también acepta `--azimut 50`. El bot muestra los mismos datos registrados que `/antena` y envía la imagen PNG del mapa. Si no hay coincidencias, genera igualmente la imagen con la ubicación indicada. La imagen no muestra flechas ni etiquetas de ángulos.

El mapa usa OpenStreetMap, incluye la atribución y conserva las teselas visibles en `data/map-tiles/` durante al menos siete días. Requiere conexión a Internet desde Node y no añade claves API. El comando mantiene los permisos del bot y solo admite chats privados. Reinicia Node y el bot después de actualizar el código.

`nodemon.json` excluye datos generados, respaldos, certificados y el entorno virtual. Así, guardar la caché del mapa no reinicia Node ni interrumpe la descarga de imágenes del bot.

Cuando `/cobertura` no encuentra una antena en `ubicaciones`, reutiliza la dirección de `georeferenciacion_ubicaciones` si ya está guardada. Si tampoco existe allí, consulta Google Geocoding y registra el resultado en esa tabla, visible en Administración → Georeferenciación. Usa `GOOGLE_GEOCODING_API_KEY`, la misma configuración de la pestaña web, y el formato de dirección y entrecalles locales existentes. No modifica `ubicaciones`. Una respuesta sin resultados no se guarda; un fallo de Geocoding se informa y permite enviar el mapa de todos modos. La consulta nueva a Google puede consumir la cuota configurada.

Python consulta el servidor Node por HTTPS; ya no utiliza credenciales MySQL.

Desde la raíz del proyecto, inicia Node con `npm run dev`. En otra terminal:

```powershell
.\.venv-telegram\Scripts\python.exe -m pip install -r telegram_bot/requirements.txt
.\.venv-telegram\Scripts\python.exe -m telegram_bot.bot
```

Configura el `.env` existente:

- `TELEGRAM_BOT_TOKEN`: token de BotFather.
- Los permisos se administran en **Administración de usuarios**, vinculando un ID de Telegram a cada cuenta activa. MySQL valida el vínculo en cada consulta.
- `TELEGRAM_API_TOKEN`: credencial aleatoria de al menos 32 caracteres entre Python y Node, independiente de BotFather. Se ha generado localmente si faltaba; no la publiques.
- `TELEGRAM_API_BASE_URL`: por defecto `https://localhost:3443`. Con Docker y puerto publicado 3444 usa `https://localhost:3444`.
- `TELEGRAM_API_CA_CERT`: certificado público de confianza, por ejemplo `certs/runtime-server.crt`; para una CA pública puede quedar vacío. No uses la clave privada. Se verifica TLS y no se siguen redirecciones.

| Comando | Endpoint GET | Consulta |
| --- | --- | --- |
| `/linea 6621234567` | `/api/bot/linea` | Línea objetivo o contacto exacto, NUC, tipo y año |
| `/línea 6621234567` | `/api/bot/linea` | Alias con tilde de `/linea`, con los mismos permisos y resultados |
 
Cada resultado de `/linea` indica el número consultado, su rol en ese registro (Objetivo, Contacto o ambos) y la línea objetivo asociada. Un mismo número puede tener diferentes roles en distintos registros.
| `/imei 123456789012345` | `/api/bot/imei` | IMEI registrado y datos asociados |
| `/antena Hermosillo` | `/api/bot/antena` | Texto literal en coordenadas, dirección o lugar |
| `/antena 29.072,-110.956` | `/api/bot/antena` | Coordenadas con la tolerancia usada por la vista web |
| `/antena 29.072 -110.956` | `/api/bot/antena` | Decimal separado por espacio, sin coma |
| `/antena 29°4'19.2"N, 110°57'21.6"W` | `/api/bot/antena` | DMS convertido a decimal antes de consultar la BD |
| `/ayuda` | — | Ejemplos |
| `/miid` | — | ID del usuario, sin conceder acceso |

Cada resultado de `/linea` indica el n?mero consultado, su rol en ese registro (Objetivo, Contacto o ambos) y la l?nea objetivo asociada. Un mismo n?mero puede tener diferentes roles en distintos registros.

Las solicitudes llevan `Authorization: Bearer <TELEGRAM_API_TOKEN>` y `X-Telegram-User-Id`. Los parámetros son `q` y `page`. JSON de respuesta: `rows`, `page`, `has_more`. Hay cinco resultados por página; añade `--pagina 2` para continuar. No admite búsquedas vacías ni modificaciones. Los endpoints usan su propia autenticación, sin cambiar la de las vistas web.

Cada ID vinculado a una cuenta activa puede consultar los registros compartidos del CRUD. El ID se guarda cifrado con AES-256-GCM y un HMAC permite validarlo sin almacenar el valor en texto claro. Conserva TELEGRAM_ID_ENCRYPTION_KEY y una copia de seguridad: perder la clave impide descifrar los IDs. Solo admite chats privados. Los resultados se envían a Telegram. `protect_content` limita el reenvío, pero no impide copiar información.

Node sigue necesitando una conexión MySQL válida. Si sus credenciales son incorrectas, la API devuelve 503 y hay que corregirlas. Las antiguas variables `TELEGRAM_DB_USER` y `TELEGRAM_DB_PASSWORD` ya no se utilizan.

`/imei` consulta datos registrados, sin llamar al proveedor externo ni generar cargos. `/antena` usa `ubicaciones`; esta tabla no tiene identificadores de celda/LAC.

Requiere Python 3.10 o posterior. Solo una instancia por token. Usa polling y descarta mensajes pendientes al iniciar. Documentación: [python-telegram-bot](https://docs.python-telegram-bot.org/en/stable/telegram.ext.application.html) y [TLS en HTTPX](https://www.python-httpx.org/advanced/ssl/).

La conexión con Telegram es directa: no utiliza los proxies de las variables de entorno. El inicio espera hasta 30 segundos para conectar y reintenta tres veces ante errores de red.

Pruebas aisladas sin BD ni Telegram reales:

```powershell
.\.venv-telegram\Scripts\python.exe -m unittest telegram_bot.test_core telegram_bot.test_api telegram_bot.test_line_results
node --test test/telegram-api.test.js test/request-security.test.js
```

Para omitir la dirección del azimut y conservar el alcance, usa `360`: `/cobertura 29.0729 -110.9559 360 1000`. Dibuja cobertura circular de 1000 m de radio. Sin indicar azimut sigue mostrando únicamente la antena.
