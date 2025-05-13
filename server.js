// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3 de Mercado Pago
const cors = require("cors");
const bodyParser = require("body-parser");
// const admin = require("firebase-admin"); // Firebase no se usa para el flujo de polling

// Inicialización de Express
const app = express();

// Middlewares
app.use(cors()); // Habilita CORS para permitir peticiones del frontend
app.use(bodyParser.json()); // Parsea cuerpos de petición JSON

// Puerto del servidor
const PORT = process.env.PORT || 3000;

// 1. Configuración de MercadoPago (Usando SDK v3)
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN, // DEBE SER TU TOKEN DE PRODUCCIÓN si vas a producción
  options: { timeout: 5000, sandbox: process.env.NODE_ENV === "development" } // NODE_ENV debe ser 'production' o no 'development' para producción
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

console.log(`Mercado Pago SDK inicializado en modo ${process.env.NODE_ENV === "development" ? 'Sandbox' : 'Producción'}`);

/* --- SECCIÓN FIREBASE COMENTADA ---
// Ya no se usará para el flujo principal de polling
const base64EncodedServiceAccount = process.env.BASE64_ENCODED_SERVICE_ACCOUNT;
let db;
if (base64EncodedServiceAccount) {
    try {
      const decodedServiceAccount = Buffer.from(base64EncodedServiceAccount, 'base64').toString('utf-8');
      const serviceAccount = JSON.parse(decodedServiceAccount);

      if (admin.apps.length === 0) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
        console.log("Firebase Admin SDK inicializado por primera vez (aunque no se use activamente para polling).");
      } else {
        console.log("Firebase Admin SDK ya estaba inicializado.");
      }
      db = admin.firestore();
      console.log("Instancia de Firestore obtenida (aunque no se use activamente para polling).");
    } catch (error) {
       console.error("ERROR: No se pudo inicializar Firebase Admin SDK o obtener Firestore.", error);
    }
} else {
    console.log("INFO: Credenciales de Firebase no configuradas.");
}
--- FIN SECCIÓN FIREBASE --- */

// --- Almacenamiento en memoria para estados de pago (PARA HTTP POLLING) ---
// ADVERTENCIA: Se pierde si el servidor/instancia de Vercel se reinicia o escala.
// Para producción robusta, considera Vercel KV, Upstash, o una base de datos externa.
let paymentStatuses = {};
console.log("INFO: Usando almacenamiento en memoria para estados de pago (HTTP Polling).");

// Limpieza periódica de estados viejos (opcional)
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    Object.keys(paymentStatuses).forEach(key => {
        if (paymentStatuses[key].createdAt && (now - new Date(paymentStatuses[key].createdAt).getTime()) > (3600000 * 3)) { // 3 horas
            delete paymentStatuses[key];
            cleanedCount++;
        }
    });
    if (cleanedCount > 0) {
        console.log(`Limpieza periódica: Se eliminaron ${cleanedCount} estados de preferencia antiguos.`);
    }
}, 600000 * 3); // Cada 30 minutos


// --- 3. Endpoints de la API ---

app.get("/", (req, res) => {
  res.send("Backend MercadoPago v2 para Vending (HTTP POLLING) 🚀");
});

app.post("/create-payment", async (req, res) => {
  console.log("Recibida petición /create-payment:", JSON.stringify(req.body, null, 2));
  try {
    const { machine_id, items } = req.body;

    if (!machine_id || !items || !Array.isArray(items) || items.length === 0) {
      console.warn("Petición /create-payment rechazada por datos faltantes...");
      return res.status(400).json({ error: "Faltan datos requeridos: machine_id y/o items válidos." });
    }

    const constructedNotificationUrl = `${process.env.BACKEND_URL}/payment-webhook`;
    console.log(">>> URL DE NOTIFICACIÓN QUE SE ENVIARÁ A MERCADO PAGO:", constructedNotificationUrl);
    if (!process.env.BACKEND_URL) {
        console.error("ALERTA: process.env.BACKEND_URL no está definida. La notification_url será inválida.");
    }

    const preferenceBody = {
      items: items.map(item => ({
        id: item.id || undefined,
        title: item.name ? item.name.substring(0, 250) : 'Producto',
        description: item.description || undefined,
        quantity: Number(item.quantity),
        currency_id: "MXN",
        unit_price: Number(item.price)
      })),
      external_reference: machine_id,
      notification_url: constructedNotificationUrl,
      back_urls: {
        success: `${process.env.FRONTEND_URL}/success?machine_id=${machine_id}`,
        failure: `${process.env.FRONTEND_URL}/error?machine_id=${machine_id}`,
        pending: `${process.env.FRONTEND_URL}/pending?machine_id=${machine_id}`
      },
      auto_return: "approved"
    };

    console.log("Creando preferencia con datos (preferenceBody):", JSON.stringify(preferenceBody, null, 2));
    const preference = await preferenceClient.create({ body: preferenceBody });
    console.log("Preferencia creada exitosamente por MP. ID de Preferencia:", preference.id);

    // Guardar estado inicial para el polling en el objeto en memoria
    paymentStatuses[preference.id] = {
      status: "pending",
      machine_id: machine_id,
      items: items,
      mp_preference_id: preference.id,
      createdAt: new Date().toISOString() // Guardar timestamp de creación
    };
    console.log(`Estado inicial para ${preference.id} ("pending") guardado en 'paymentStatuses'.`);

    res.json({
      id: preference.id, // Este es el preference.id
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point
    });

  } catch (error) {
    console.error("Error al crear preferencia de pago:", error.cause || error.message || error);
    const errorDetails = error.cause ? JSON.stringify(error.cause, null, 2) : error.message;
    res.status(500).json({ error: "No se pudo crear la preferencia de pago.", details: errorDetails });
  }
});

// --- NUEVO ENDPOINT GET /payment-status PARA POLLING ---
app.get("/payment-status", (req, res) => {
  const preferenceId = req.query.preference_id; // Recibimos el ID como query parameter

  if (!preferenceId) {
    return res.status(400).json({ error: "Falta el parámetro 'preference_id'." });
  }
  console.log(`\n--- [${new Date().toISOString()}] INICIO GET /payment-status ---`);
  console.log(`Solicitud de estado (polling) para preference_id: ${preferenceId}`);

  const transaction = paymentStatuses[preferenceId]; // paymentStatuses es tu objeto en memoria

  if (!transaction) {
    console.log(`Estado para ${preferenceId} NO encontrado en 'paymentStatuses'. Devolviendo not_found.`);
    return res.status(404).json({ // Es importante que devuelva JSON también en el error 404 que manejas
        preference_id: preferenceId,
        status: "not_found", 
        message: "Transacción no encontrada. Puede que aún no se haya creado o el ID sea incorrecto/antiguo."
    });
  }

  console.log(`Devolviendo estado para ${preferenceId}: ${transaction.status}`);
  res.json({ // La respuesta DEBE ser JSON
    preference_id: preferenceId,
    status: transaction.status,
    machine_id: transaction.machine_id
  });
  console.log(`--- [${new Date().toISOString()}] FIN GET /payment-status ---`);
});
// --- FIN ENDPOINT GET /payment-status ---

// --- Endpoint de prueba simple ---
app.post("/test-webhook", (req, res) => {
  console.log(`\n--- [${new Date().toISOString()}] INICIO Webhook /test-webhook (RUTA DE PRUEBA SIMPLIFICADA) ---`);
  console.log("Headers del /test-webhook:", JSON.stringify(req.headers, null, 2));
  console.log("Cuerpo del /test-webhook (parseado):", JSON.stringify(req.body, null, 2));
  console.log("Query params del /test-webhook:", JSON.stringify(req.query, null, 2));
  res.status(200).json({
    message: "Test webhook received successfully at /test-webhook",
    body_received: req.body,
    query_received: req.query
  });
  console.log(`--- [${new Date().toISOString()}] FIN Webhook /test-webhook (Respuesta 200 enviada) ---`);
});

// --- WEBHOOK PRINCIPAL: ACTUALIZA 'paymentStatuses' PARA POLLING ---
app.post("/payment-webhook", async (req, res) => {
  console.log(`\n--- [${new Date().toISOString()}] INICIO Webhook /payment-webhook ---`);
  console.log("Headers del Webhook:", JSON.stringify(req.headers, null, 2));
  console.log("Cuerpo del Webhook (parseado):", JSON.stringify(req.body, null, 2));

  const notificationType = req.body.type || req.query.type;
  const paymentIdFromData = req.body.data?.id;
  const paymentIdFromQuery = req.query['data.id'] || req.query.id;
  let paymentId = paymentIdFromData || paymentIdFromQuery;

  console.log(`Tipo de notificación recibida: ${notificationType}`);
  console.log(`ID de pago (desde data.id en body): ${paymentIdFromData}`);
  console.log(`ID de pago (desde query 'data.id' o 'id'): ${paymentIdFromQuery}`);
  console.log(`ID de pago a usar: ${paymentId}`);

  if (notificationType !== 'payment' || !paymentId) {
     console.log("Notificación ignorada (no es de tipo 'payment' o falta ID de pago).");
     console.log(`--- [${new Date().toISOString()}] FIN Webhook (Ignorado/ID no encontrado) ---`);
     return res.sendStatus(200);
  }

  try {
    console.log(`[TRY] Procesando notificación para Payment ID: ${paymentId}`);
    console.log(`[TRY] Llamando a paymentClient.get({ id: ${paymentId} })...`);
    const payment = await paymentClient.get({ id: paymentId });
    console.log(`[TRY] Llamada a paymentClient.get completada.`);

    if (!payment) {
        console.error(`[TRY] No se encontraron detalles en MP para el Payment ID: ${paymentId}.`);
        console.log(`--- [${new Date().toISOString()}] FIN Webhook (Error: Pago no encontrado en MP) ---`);
        return res.sendStatus(200);
    }

    const externalReference = payment.external_reference;
    const paymentStatus = payment.status;
    let preferenceId = payment.preference_id;
    if (!preferenceId && payment.order && payment.order.type === "mercadopago") {
        preferenceId = payment.order.id;
    }

    console.log("----------------------------------------------------");
    console.log("--- DETALLES DEL PAGO OBTENIDOS DE MERCADO PAGO ---");
    console.log(`  Payment ID: ${payment.id}`);
    console.log(`  Status: ${paymentStatus}`);
    console.log(`  Status Detail: ${payment.status_detail}`);
    console.log(`  Preference ID: ${preferenceId || 'No encontrado en objeto payment'}`);
    console.log(`  External Reference (Machine ID): ${externalReference}`);
    // ... (otros logs de detalles del pago que quieras mantener) ...
    console.log("----------------------------------------------------");

    // Actualizar estado en nuestro almacenamiento en memoria para polling
    if (preferenceId && paymentStatuses[preferenceId]) {
      paymentStatuses[preferenceId].status = paymentStatus;
      paymentStatuses[preferenceId].mp_payment_id = payment.id;
      paymentStatuses[preferenceId].payment_status_detail = payment.status_detail;
      paymentStatuses[preferenceId].updatedAt = new Date().toISOString();
      // También podrías añadir más detalles del payment object si son útiles para /payment-status
      // paymentStatuses[preferenceId].payment_details_from_mp = { amount: payment.transaction_amount, currency: payment.currency_id, ... };
      console.log(`Estado para Preference ID ${preferenceId} actualizado a '${paymentStatus}' en 'paymentStatuses'.`);
    } else if (preferenceId) {
      console.warn(`No se encontró estado inicial para polling para preference_id: ${preferenceId}. Creando entrada...`);
      paymentStatuses[preferenceId] = {
          status: paymentStatus,
          machine_id: externalReference,
          mp_preference_id: preferenceId,
          mp_payment_id: payment.id,
          payment_status_detail: payment.status_detail,
          createdAt: payment.date_created || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          items: payment.additional_info?.items || [] // Puede que no venga aquí
      };
    } else {
        console.error(`[TRY] ERROR CRÍTICO: No se pudo determinar el preference_id para Payment ID ${paymentId}. No se puede actualizar 'paymentStatuses'.`);
    }

    if (paymentStatus === 'approved') {
        const machineId = externalReference;
        console.log(`[INFO] PAGO APROBADO para Payment ID ${paymentId}, (Pref ID: ${preferenceId || 'N/A'}), Machine ${machineId}.`);
        console.log(`[INFO] 🚀 Aquí iría la lógica para notificar a la máquina ${machineId} que dispense el producto.`);
    } else {
        console.log(`[INFO] Estado del pago ${paymentId} es '${paymentStatus}'. No se ejecutan acciones de dispensación.`);
    }

    console.log(`[TRY] Enviando respuesta 200 OK a Mercado Pago...`);
    res.sendStatus(200);
    console.log(`--- [${new Date().toISOString()}] FIN Webhook (Procesado y Logueado en 'paymentStatuses') ---`);

  } catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("!!!!!!!!    Error en CATCH procesando webhook    !!!!!!!!!");
    // ... (resto de tu manejo de error en catch) ...
    if (error.cause) {
         console.error("Error Cause (SDK Mercado Pago):", JSON.stringify(error.cause, null, 2));
    } else {
         console.error("Error Object (General):", error);
    }
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    const statusCode = error.statusCode || 500;
    console.log(`[CATCH] Enviando respuesta ${statusCode} a Mercado Pago...`);
    res.sendStatus(statusCode);
    console.log(`--- [${new Date().toISOString()}] FIN Webhook (Error en Catch) ---`);
  }
});

// --- NUEVO ENDPOINT GET /payment-status PARA POLLING ---
app.get("/payment-status", (req, res) => {
  const preferenceId = req.query.preference_id;

  if (!preferenceId) {
    return res.status(400).json({ error: "Falta el parámetro 'preference_id'." });
  }
  console.log(`\n--- [${new Date().toISOString()}] INICIO GET /payment-status ---`);
  console.log(`Solicitud de estado (polling) para preference_id: ${preferenceId}`);

  const transaction = paymentStatuses[preferenceId];

  if (!transaction) {
    console.log(`Estado para ${preferenceId} NO encontrado en 'paymentStatuses'. Devolviendo not_found.`);
    return res.status(404).json({
        preference_id: preferenceId,
        status: "not_found", // Para que la app sepa que no existe (aún) o ya fue limpiado
        message: "Transacción no encontrada. Puede que aún no se haya creado o el ID sea incorrecto/antiguo."
    });
  }

  console.log(`Devolviendo estado para ${preferenceId}: ${transaction.status}`);
  res.json({
    preference_id: preferenceId,
    status: transaction.status,
    machine_id: transaction.machine_id,
    // Podrías añadir más detalles si la app los necesita:
    // items: transaction.items,
    // payment_status_detail: transaction.payment_status_detail
  });
  console.log(`--- [${new Date().toISOString()}] FIN GET /payment-status ---`);
});
// --- FIN ENDPOINT GET /payment-status ---


// --- Iniciar el Servidor ---
app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en puerto ${PORT}`);
  console.log(`URL Base (asegúrate que BACKEND_URL sea pública para webhooks): ${process.env.BACKEND_URL || 'URL NO DEFINIDA -> ¡WEBHOOKS FALLARÁN!'}`);
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) console.error("ALERTA: MERCADOPAGO_ACCESS_TOKEN no está definido.");
  if (!process.env.FRONTEND_URL) console.warn("ADVERTENCIA: FRONTEND_URL no está definido (back_urls podrían fallar).");
  console.log(`INFO: Este backend está configurado para MODO ${process.env.NODE_ENV === "development" ? 'Sandbox' : 'Producción'}.`);
  console.log("INFO: Usando HTTP Polling con almacenamiento en memoria para estados de pago.");
});
