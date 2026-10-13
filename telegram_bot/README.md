# Bot de consultas mediante API

Python consulta el servidor Node por HTTPS; ya no utiliza credenciales MySQL.

Desde la raíz del proyecto, inicia Node con `npm run dev`. En otra terminal:

```powershell
.\.venv-telegram\Scripts\python.exe -m pip install -r telegram_bot/requirements.txt
.\.venv-telegram\Scripts\python.exe -m telegram_bot.bot
```

Configura el `.env` existente:

- `TELEGRAM_BOT_TOKEN`: token de BotFather.
- `TELEGRAM_ALLOWED_USER_IDS`: IDs numéricos autorizados separados por comas. Reinicia Python y Node al cambiar la lista; ambos la comprueban. El bot no inicia con la lista vacía.
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

Cada ID autorizado puede consultar los registros compartidos del CRUD; la lista es independiente de las cuentas web. Solo admite chats privados. Los resultados se envían a Telegram. `protect_content` limita el reenvío, pero no impide copiar información.

Node sigue necesitando una conexión MySQL válida. Si sus credenciales son incorrectas, la API devuelve 503 y hay que corregirlas. Las antiguas variables `TELEGRAM_DB_USER` y `TELEGRAM_DB_PASSWORD` ya no se utilizan.

`/imei` consulta datos registrados, sin llamar al proveedor externo ni generar cargos. `/antena` usa `ubicaciones`; esta tabla no tiene identificadores de celda/LAC.

Requiere Python 3.10 o posterior. Solo una instancia por token. Usa polling y descarta mensajes pendientes al iniciar. Documentación: [python-telegram-bot](https://docs.python-telegram-bot.org/en/stable/telegram.ext.application.html) y [TLS en HTTPX](https://www.python-httpx.org/advanced/ssl/).

Pruebas aisladas sin BD ni Telegram reales:

```powershell
.\.venv-telegram\Scripts\python.exe -m unittest telegram_bot.test_core telegram_bot.test_api telegram_bot.test_line_results
node --test test/telegram-api.test.js test/request-security.test.js
```
