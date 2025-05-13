// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3 de Mercado Pago
const cors = require("cors");
const bodyParser = require("body-parser");
// const admin = require("firebase-admin"); // Descomenta si necesitas Firebase para OTRA COSA

// Inicialización de Express
const app = express();

// Middlewares
app.use(cors()); // Habilita CORS para permitir peticiones del frontend
app.use(bodyParser.json()); // Parsea cuerpos de petición JSON

// Puerto del servidor
const PORT = process.env.PORT || 3000;

// 1. Configuración de MercadoPago (Usando SDK v3)
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN, // DEBE SER TU TOKEN DE PRODUCCIÓN
  options: { timeout: 5000, sandbox: process.env.NODE_ENV === "development" } // NODE_ENV debe ser 'production' o no 'development'
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

console.log(`Mercado Pago SDK inicializado en modo ${process.env.NODE_ENV === "development" ? 'Sandbox' : 'Producción'}`);

// 2. Configuración de Firebase Admin SDK (Opcional si no se usa para nada más)
/* --- Comenta esta sección si no usarás Firebase para nada ---
const base64EncodedServiceAccount = process.env.BASE64_ENCODED_SERVICE_ACCOUNT;
let db;

if (!base64EncodedServiceAccount && process.env.SHOULD_USE_FIRESTORE === 'true') { // Añade una variable para controlar si se usa Firestore
  console.error("ERROR: BASE64_ENCODED_SERVICE_ACCOUNT no definida, pero SHOULD_USE_FIRESTORE es true.");
  // Decide si quieres que el proceso termine o solo loguee una advertencia
  // process.exit(1); 
}

if (base64EncodedServiceAccount && process.env.SHOULD_USE_FIRESTORE === 'true') {
    try {
      const decodedServiceAccount = Buffer.from(base64EncodedServiceAccount, 'base64').toString('utf-8');
      const serviceAccount = JSON.parse(decodedServiceAccount);

      if (admin.apps.length === 0) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
        console.log("Firebase Admin SDK inicializado por primera vez.");
      } else {
        console.log("Firebase Admin SDK ya estaba inicializado.");
      }
      db = admin.firestore();
      console.log("Instancia de Firestore obtenida.");
    } catch (error) {
       console.error("ERROR FATAL: No se pudo inicializar Firebase Admin SDK o obtener Firestore.", error);
       // process.exit(1);
    }
} else {
    console.log("INFO: Interacción con Firestore DESHABILITADA o no configurada (BASE64_ENCODED_SERVICE_ACCOUNT o SHOULD_USE_FIRESTORE no están listos).");
}
--- Fin sección Firebase --- */
console.log("INFO: El webhook actual solo logueará el estado del pago, no escribirá en Firestore.");


// --- 3. Endpoints de la API ---

app.get("/", (req, res) => {
  res.send("Backend MercadoPago v2 para Vending (PRODUCCIÓN - Sin escritura Firestore en webhook) 🚀");
});

app.post("/create-payment", async (req, res) => {
  console.log("Recibida petición /create-payment:", JSON.stringify(req.body, null, 2));
  try {
    const { machine_id, items } = req.body;

    if (!machine_id || !items || !Array.isArray(items) || items.length === 0) {
      console.warn("Petición /create-payment rechazada por datos faltantes:", { machine_id, items_type: typeof items, items_length: items?.length });
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

    /* --- ESCRITURA EN FIRESTORE COMENTADA ---
    if (db) { // Solo intentar si db fue inicializado
        const transactionData = {
          machine_id: machine_id,
          status: "pending",
          items: items,
          mp_preference_id: preference.id,
          created_at: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection("transactions").doc(preference.id).set(transactionData);
        console.log(`Transacción inicial guardada en Firestore con ID: ${preference.id}`);
    } else {
        console.log("ADVERTENCIA: Firestore (db) no está disponible. No se guardó la transacción inicial.");
    }
    */
    console.log("INFO: No se está guardando la transacción inicial en Firestore en este flujo.");


    res.json({
      id: preference.id,
      init_point: preference.init_point, // En producción, este es el que se usa
      sandbox_init_point: preference.sandbox_init_point // Será null o no usado en producción
    });

  } catch (error) {
    console.error("Error al crear preferencia de pago:", error.cause || error.message || error);
    const errorDetails = error.cause ? JSON.stringify(error.cause, null, 2) : error.message;
    res.status(500).json({ error: "No se pudo crear la preferencia de pago.", details: errorDetails });
  }
});

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

// --- WEBHOOK PRINCIPAL MODIFICADO: SOLO LEE Y LOGUEA, NO ESCRIBE EN FIRESTORE ---
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
        return res.sendStatus(200); // Responder OK a MP para evitar reintentos por este caso
    }

    const externalReference = payment.external_reference;
    const paymentStatus = payment.status;
    const preferenceId = payment.preference_id; // Útil para correlacionar con la creación

    console.log("----------------------------------------------------");
    console.log("--- DETALLES DEL PAGO OBTENIDOS DE MERCADO PAGO ---");
    console.log(`  Payment ID: ${payment.id}`);
    console.log(`  Status: ${paymentStatus}`);
    console.log(`  Status Detail: ${payment.status_detail}`);
    console.log(`  Preference ID: ${preferenceId}`);
    console.log(`  External Reference (Machine ID): ${externalReference}`);
    console.log(`  Date Created: ${payment.date_created}`);
    console.log(`  Date Approved: ${payment.date_approved}`);
    console.log(`  Transaction Amount: ${payment.transaction_amount} ${payment.currency_id}`);
    console.log("----------------------------------------------------");


    // Lógica de negocio basada en el estado del pago (sin escribir en Firestore)
    if (paymentStatus === 'approved') {
        const machineId = externalReference;
        console.log(`[INFO] PAGO APROBADO para Payment ID ${paymentId}, Preference ID ${preferenceId}, Machine ${machineId}.`);
        console.log(`[INFO] 🚀 Aquí iría la lógica para notificar a la máquina ${machineId} que dispense el producto.`);
        // Ejemplo:
        // if (machineId) {
        //   await notificarDispensador(machineId, payment.items || []); // Función hipotética
        // }
    } else {
        console.log(`[INFO] Estado del pago ${paymentId} es '${paymentStatus}'. No se ejecutan acciones de dispensación.`);
    }

    console.log(`[TRY] Enviando respuesta 200 OK a Mercado Pago...`);
    res.sendStatus(200);
    console.log(`--- [${new Date().toISOString()}] FIN Webhook (Procesado y Logueado) ---`);

  } catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("!!!!!!!!    Error en CATCH procesando webhook    !!!!!!!!!");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    if (error.cause) { // Errores del SDK de MP a menudo tienen 'cause' con detalles
         console.error("Error Cause (SDK Mercado Pago):", JSON.stringify(error.cause, null, 2));
    } else {
         console.error("Error Object (General):", error);
    }
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    const statusCode = error.statusCode || 500; // Usar statusCode del error si existe
    console.log(`[CATCH] Enviando respuesta ${statusCode} a Mercado Pago...`);
    res.sendStatus(statusCode);
    console.log(`--- [${new Date().toISOString()}] FIN Webhook (Error en Catch) ---`);
  }
});
// --- FIN DEL WEBHOOK MODIFICADO ---


// --- Iniciar el Servidor ---
app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en puerto ${PORT}`);
  console.log(`URL Base (asegúrate que BACKEND_URL sea pública para webhooks): ${process.env.BACKEND_URL || 'URL NO DEFINIDA -> ¡WEBHOOKS FALLARÁN!'}`);
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) console.error("ALERTA: MERCADOPAGO_ACCESS_TOKEN no está definido.");
  // Ya no es crítico si no se usa Firestore, pero la variable podría seguir existiendo
  // if (!process.env.BASE64_ENCODED_SERVICE_ACCOUNT) console.warn("ADVERTENCIA: BASE64_ENCODED_SERVICE_ACCOUNT no está definido.");
  if (!process.env.FRONTEND_URL) console.warn("ADVERTENCIA: FRONTEND_URL no está definido (back_urls podrían fallar).");
  console.log("INFO: Este backend está configurado para MODO PRODUCCIÓN (si NODE_ENV no es 'development').");
  console.log("INFO: Webhook solo logueará estado de pago, SIN escritura en Firestore.");
});
