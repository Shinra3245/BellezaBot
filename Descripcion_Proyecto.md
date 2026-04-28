# SaaS de Agendamiento con IA para Negocios de Estética

## Rol del Asesor Técnico

Experto desarrollador de software con experiencia en tecnologías web, IA y APIs, con el rol de asesor técnico dentro de la construcción del proyecto. Proporciona código limpio y escalable, así como la explicación del uso de cada tecnología o técnica implementada. De igual forma, brinda asesoría ante problemas técnicos o de gestión de ideas, y apoya la implementación de nuevas ideas que el usuario requiera.

---

## El Problema que Resuelve

Los negocios de estética operan en un contexto donde el dueño o empleado tiene las manos ocupadas todo el tiempo. Esto produce tres problemas en cadena:

- No contestan mensajes a tiempo y pierden clientes.
- Gestionan citas en libretas o de memoria, causando empalmes y olvidos.
- No tienen sistema de recordatorios que reduzca los no-shows.

El proyecto construye una solución SaaS que automatiza completamente la recepción de clientes vía mensajería, la agenda y los recordatorios, todo sin que el dueño levante un dedo.

---

## Arquitectura Técnica en Detalle

### 1. Canal de Comunicación: WhatsApp Business API (y Meta Graph API)

El punto de entrada del sistema es WhatsApp. Cuando un cliente manda un mensaje al número del negocio, Meta notifica al backend a través de un **webhook** (una URL pública que el servidor expone). La integración se hace directamente con Meta o a través de Twilio como intermediario.

```
Cliente envía mensaje → Meta envía POST a tu webhook → Node.js lo recibe
```

El mismo motor soporta Instagram Direct y Facebook Messenger usando la misma Meta Graph API, cambiando solo el identificador de canal. El `business_id` del negocio unifica todas las conversaciones en el panel web, sin importar de qué red social vinieron.

---

### 2. Backend: Node.js + Express

El servidor central cumple varias responsabilidades:

#### Webhook Handler

Recibe el payload JSON que manda Meta. Extrae el número del remitente, identifica a qué negocio pertenece ese número de WhatsApp, y pasa el mensaje al siguiente eslabón.

#### Middleware de Validación de Suscripción

Antes de gastar tokens de IA o responder, el backend consulta la tabla `businesses` en PostgreSQL y revisa dos campos:

```js
// Ejemplo de middleware de validación
async function checkSubscription(req, res, next) {
  const business = await db.query(
    'SELECT is_active, subscription_expiry FROM businesses WHERE wa_phone = $1',
    [req.body.phone]
  );

  const now = new Date();
  if (!business.is_active || business.subscription_expiry < now) {
    // El bot responde un mensaje predefinido y NO llama a la IA
    return sendWhatsAppMessage(req.body.phone, "Este servicio no está disponible en este momento.");
  }
  next();
}
```

Esto protege los costos: si el cliente no pagó su suscripción, el bot se apaga automáticamente.

#### Motor de IA con Function Calling

El sistema envía el historial de conversación a la API de Claude o GPT con un `system_prompt` que se construye dinámicamente con los datos del negocio:

```js
const systemPrompt = `
  Eres el asistente virtual de "${business.name}".
  Personalidad: ${business.bot_personality}
  Servicios disponibles: ${JSON.stringify(business.services)}
  Horario de atención: ${business.schedule}
  Idioma: español, tono ${business.tone}.
`;
```

La IA tiene acceso a funciones (tools) que puede llamar cuando detecta la intención de agendar:

- `check_availability(date, service_id)` → consulta huecos libres en `appointments`
- `create_appointment(client_phone, service_id, datetime)` → inserta la cita
- `get_service_info(service_name)` → regresa precio y duración actualizada

Esto garantiza que el bot nunca ofrezca un horario ocupado y siempre use los precios vigentes en tiempo real.

---

### 3. Base de Datos: PostgreSQL Multi-Tenant

El diseño de tablas es el corazón del modelo multi-tenant. Cada tabla tiene un `business_id` que asegura aislamiento total entre negocios:

```sql
-- Un negocio registrado en la plataforma
CREATE TABLE businesses (
  id UUID PRIMARY KEY,
  name TEXT,
  wa_phone TEXT UNIQUE,
  bot_personality TEXT,
  tone TEXT,
  is_active BOOLEAN DEFAULT true,
  subscription_expiry TIMESTAMP
);

-- Servicios del negocio (actualizables desde el panel web)
CREATE TABLE services (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id),
  name TEXT,        -- "Corte de dama"
  price NUMERIC,
  duration_minutes INT
);

-- Horarios disponibles configurados por el dueño
CREATE TABLE schedules (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id),
  day_of_week INT,  -- 0=Lunes, 6=Domingo
  start_time TIME,
  end_time TIME
);

-- Las citas agendadas
CREATE TABLE appointments (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id),
  client_phone TEXT,
  service_id UUID REFERENCES services(id),
  datetime TIMESTAMP,
  status TEXT CHECK (status IN ('pending','confirmed','rescheduled','cancelled'))
);
```

Cuando el dueño cambia un precio de $150 a $200 en el panel web, el bot lo refleja en la siguiente conversación sin ningún ajuste adicional, porque la IA consulta la tabla `services` en tiempo real.

---

### 4. Panel Web: React

El dueño accede a una interfaz donde puede:

- **Ver su calendario** con todas las citas del día/semana, su estado y el cliente.
- **Configurar el bot**: nombre del negocio, tono de comunicación, personalidad, servicios con precios y duración.
- **Subir portafolio**: URLs de imágenes que el bot puede enviar cuando un cliente pide ver trabajos anteriores.
- **Mover o cancelar citas**: al hacerlo, el sistema dispara automáticamente un mensaje de plantilla (Template Message) al cliente:

```
"Hola [Nombre], tu cita de [Servicio] agendada para [Fecha/Hora] ha sido
reprogramada para las 5:00 PM. ¿Te queda bien este horario? Responde
Sí o No."
```

La autenticación usa **JWT (JSON Web Tokens)**: el dueño inicia sesión, recibe un token firmado, y cada petición al backend lo valida. El super-administrador puede revocar tokens de cualquier negocio de forma remota.

---

### 5. Super-Administrador

Una capa por encima de todos los negocios, con acceso a:

- Dashboard de todos los tenants (negocios) registrados.
- Control de `subscription_expiry` e `is_active` por negocio.
- Reset de contraseñas y revocación de JWT.
- Métricas de consumo (cuántas conversaciones, cuántos tokens de IA por negocio).

---

## Modelo de Negocio

El proyecto se distribuye como SaaS con suscripción mensual de **$500–$800 MXN por negocio**. El costo es equivalente a 1–2 servicios del propio salón, lo que lo hace una venta con muy poca fricción. Opcionalmente se cobra un setup fee único de ~$500 MXN por configurar el número de WhatsApp, cargar los servicios y ajustar la personalidad del bot.

### Proyección de Rentabilidad

Con 20 negocios suscritos a $40 USD/mes:

- **Ingresos brutos:** $800 USD/mes
- **Costos operativos totales** (servidor, base de datos, IA, WhatsApp API): ~$90 USD/mes
- **Margen neto:** ~90%

Al escalar a 50 o 100 clientes, los costos de infraestructura crecen de forma marginal mientras los ingresos se multiplican linealmente.

---

## Resumen del Stack Tecnológico

El canal de comunicación con el cliente final se maneja a través de la **Meta Graph API**, que unifica WhatsApp Business, Instagram Direct y Facebook Messenger en un solo punto de integración. Todos los mensajes entrantes llegan al backend como webhooks, independientemente de la red social de origen.

El backend está construido con **Node.js y Express**, que es el núcleo del sistema. Se encarga de recibir los webhooks de Meta, ejecutar el middleware de validación de suscripción, orquestar las llamadas a la IA y gestionar toda la lógica de negocio como estados de citas y notificaciones push.

El cerebro del bot es un modelo de inteligencia artificial, ya sea **Claude Haiku de Anthropic o GPT-4o-mini de OpenAI**. Ambos son modelos rápidos y económicos que se usan con la técnica de Function Calling, lo que le permite a la IA detectar la intención del cliente y ejecutar acciones concretas en la base de datos, como consultar disponibilidad o confirmar una cita.

La persistencia de datos recae en **PostgreSQL**, desplegado a través de servicios como Supabase o Neon. La base de datos está diseñada con una arquitectura multi-tenant, donde cada tabla incluye un `business_id` que garantiza el aislamiento total entre los datos de distintos negocios.

El panel web que usan tanto el dueño del negocio como el super-administrador está construido con **React**. Desde ahí se gestiona el calendario, se configura la personalidad del bot, se actualizan servicios y precios, y se controlan las suscripciones de cada tenant.

La autenticación en toda la plataforma se maneja con **JWT (JSON Web Tokens)**, lo que permite sesiones seguras y la posibilidad de revocar accesos de forma remota desde el panel de administración.

Finalmente, el despliegue del backend y el frontend se realiza en plataformas como **Vercel, Render o Railway**, que ofrecen planes iniciales de bajo costo ideales para el MVP, con capacidad de escalar conforme crece la base de clientes.
