# Auditoría de Seguridad - Media Service

Basado en la teoría de Seguridad (CIA Triad, Tácticas y Patrones Arquitectónicos):

## Cumple

### Tácticas: Resistir Ataques
*   **Encrypt Data:** Fastify expone únicamente el puerto **8443** con TLS mutuo. En `src/index.ts` se configura:
    *   `key`, `cert`, `ca` leídos de paths de certificados.
    *   `requestCert: true` (exige certificado de cliente).
    *   `rejectUnauthorized: true` (rechaza conexiones sin certificado válido).
    *   `minVersion: "TLSv1.2"`.
*   **Authenticate Actor:** 
    *   **mTLS mutua:** `requestCert: true` + `rejectUnauthorized: true` en el servidor HTTPS de Fastify.
    *   **Aplicación (JWT/Firebase):** `src/middleware/auth.ts` valida tokens Firebase en el header `Authorization` antes de permitir uploads.
*   **Limit Access:** En docker-compose solo se expone el puerto **8443** internamente; el tráfico entra únicamente a través del gateway NGINX. El middleware de multipart limita tamaño de archivo (`MAX_FILE_SIZE_MB`) y cantidad de archivos (`files: 1`).
*   **Change Default Settings:** 
    *   No hay secrets hardcodeados en el código; todas las credenciales se leen desde variables de entorno (`env.ts`).
    *   En producción, `env.ts` hace *fail-fast* si faltan variables obligatorias (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `GOOGLE_APPLICATION_CREDENTIALS`).
    *   RabbitMQ se conecta vía **AMQPS 5671** (`amqps://...` en `.env`).

### Tácticas: Detectar Ataques / Recuperar
*   **Maintain Audit Trail:** Logs estructurados con `pino` (nivel `info` en producción). Endpoint de healthcheck (`/api/media/health`). Healthcheck en docker-compose realiza petición HTTPS con certificado de cliente.

## No Cumple / Gaps conocidos
*   **Redis sin TLS:** El cliente Redis (`ioredis`) se conecta mediante `redis://` sin cifrado TLS. En una arquitectura Zero-Trust, el canal entre media-service y Redis debería usar `rediss://` con certificados. Esto representa un gap conocido dado que Redis almacena hashes de imágenes y metadatos de caché.
*   **Dockerfile desincronizado:** El `Dockerfile` expone `8084` y no define `HEALTHCHECK`. El healthcheck se define únicamente en docker-compose.
*   **Usuario root en contenedor:** El Dockerfile no define un usuario no privilegiado (`USER`). El proceso Node.js corre como root dentro del contenedor.

## Decisiones del Laboratorio 5
*   **Aplicación del Secure Channel Pattern en este servicio:** Se implementó TLS 1.2+ en el puerto 8443 con autenticación mutua (`requestCert: true`, `rejectUnauthorized: true`) en Fastify. La comunicación con RabbitMQ se migró a AMQPS 5671. Queda pendiente el cifrado del canal hacia Redis (`rediss://`) como siguiente hardening en el roadmap de Zero-Trust.
