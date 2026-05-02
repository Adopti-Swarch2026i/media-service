# media-service

> Microservicio de procesamiento y almacenamiento de imágenes para **Adopti**.

## Descripción

`media-service` es un componente lógico del sistema Adopti que recibe imágenes desde los clientes (web SSR y móvil Flutter), las procesa (validación, strip EXIF, thumbnail), las sube a Cloudinary y cachea las URLs resultantes en Redis para evitar uploads duplicados.

Emite eventos al broker RabbitMQ (`pet.image.uploaded`) siguiendo el contrato de eventos del equipo.

## Stack

| Tecnología | Uso |
|---|---|
| Node.js 20 + TypeScript | Runtime + lenguaje |
| Fastify 5 | Framework HTTP |
| sharp | Procesamiento de imágenes (EXIF strip, thumbnail, resize) |
| Cloudinary SDK v2 | Object storage en la nube |
| ioredis | Cache de hash → URLs (deduplicación) |
| amqplib | Publisher de eventos a RabbitMQ |
| firebase-admin | Verificación de tokens de autenticación |

## Arquitectura

```
POST /api/media/upload
       │
       ▼
  ┌──────────┐     ┌───────────┐     ┌────────────┐
  │ Validate │────▶│ Process   │────▶│ Redis      │
  │ size+MIME│     │ EXIF strip│     │ cache check│
  └──────────┘     │ thumbnail │     └─────┬──────┘
                   │ SHA-256   │           │
                   └───────────┘      HIT? │
                                      ├─── YES → return cached URLs
                                      │
                                      └─── NO
                                           │
                                    ┌──────▼──────┐
                                    │ Cloudinary  │
                                    │ upload      │
                                    │ orig+thumb  │
                                    └──────┬──────┘
                                           │
                                    ┌──────▼──────┐     ┌──────────┐
                                    │ Redis SET   │────▶│ RabbitMQ │
                                    │ cache URLs  │     │ publish  │
                                    └─────────────┘     └──────────┘
```

## Endpoints

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `POST` | `/api/media/upload` | Bearer token | Sube una imagen (multipart/form-data) |
| `GET` | `/api/media/:hash` | — | Devuelve URLs cacheadas por hash SHA-256 |
| `GET` | `/api/media/health` | — | Health check |

### `POST /api/media/upload`

**Request:**
```
Content-Type: multipart/form-data
Authorization: Bearer <firebase-id-token>

Fields:
  file: <binary image>
  petId: (optional) ID del reporte de mascota asociado
```

**Response (201 Created):**
```json
{
  "url": "https://res.cloudinary.com/…/original.jpg",
  "thumbnailUrl": "https://res.cloudinary.com/…/thumb.jpg",
  "hash": "a1b2c3d4e5f6…",
  "cached": false
}
```

**Response (200 OK — cache hit):**
```json
{
  "url": "https://res.cloudinary.com/…/original.jpg",
  "thumbnailUrl": "https://res.cloudinary.com/…/thumb.jpg",
  "hash": "a1b2c3d4e5f6…",
  "cached": true
}
```

### Evento emitido

```
Exchange: adopti.events (topic)
Routing key: pet.image.uploaded

Payload:
{
  "userId": "firebase-uid",
  "petId": "123" | null,
  "url": "https://…",
  "thumbnailUrl": "https://…",
  "hash": "sha256hex"
}

Headers:
  eventId: UUID v4
  eventTimestamp: ISO 8601
```

## Desarrollo local

### Prerrequisitos

- Node.js 20+
- Redis corriendo en `localhost:6379`
- RabbitMQ corriendo en `localhost:5672`
- Credenciales de Cloudinary
- `firebase-credentials.json` en la raíz

### Setup

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales reales

# 3. Iniciar en modo desarrollo (hot-reload)
npm run dev
```

### Con Docker Compose

```bash
# Levanta Redis + RabbitMQ + media-service
docker compose up -d --build

# Ver logs
docker compose logs -f media-service

# Health check
curl http://localhost:8084/api/media/health
```

### Probar upload con curl

```bash
curl -X POST http://localhost:8084/api/media/upload \
  -H "Authorization: Bearer <your-firebase-id-token>" \
  -F "file=@/path/to/image.jpg" \
  -F "petId=42"
```

## Estructura del proyecto

```
media-service/
├── src/
│   ├── config/
│   │   ├── env.ts            # Variables de entorno centralizadas
│   │   ├── cloudinary.ts     # Inicialización SDK Cloudinary
│   │   ├── redis.ts          # Singleton ioredis
│   │   └── firebase.ts       # Firebase Admin SDK
│   ├── messaging/
│   │   └── publisher.ts      # Publisher RabbitMQ (adopti.events)
│   ├── middleware/
│   │   └── auth.ts           # Verificación Bearer token Firebase
│   ├── services/
│   │   └── media.service.ts  # Lógica de negocio principal
│   ├── routes/
│   │   └── media.routes.ts   # Endpoints Fastify
│   ├── utils/
│   │   └── image.ts          # Validación MIME, EXIF strip, thumbnail
│   └── index.ts              # Entry point
├── Dockerfile                 # Multi-stage build
├── docker-compose.yml         # Dev stack (Redis + RabbitMQ + service)
├── .env.example
├── .dockerignore
├── package.json
└── tsconfig.json
```

## Validaciones de imagen

- **Tamaño máximo:** 5 MB (configurable via `MAX_FILE_SIZE_MB`)
- **Formatos:** JPG, PNG, WEBP (validación por magic bytes, no extensión)
- **EXIF:** se elimina automáticamente por privacidad
- **Thumbnail:** 300px de ancho (configurable via `THUMBNAIL_WIDTH`)
- **Deduplicación:** hash SHA-256 → si ya existe en Redis, no re-sube a Cloudinary

## Puerto

`8084` (interno en Docker, expuesto al gateway NGINX como `/api/media`)
