// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3 de Mercado Pago
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin"); // <<<--- Firebase Admin SDK está activo

// Inicialización de Express
const app = express();

// Middlewares
app.use(cors()); // Habilita CORS para permitir peticiones del frontend
app.use(bodyParser.json()); // Parsea cuerpos de petición JSON

// Puerto del servidor
const PORT = process.env.PORT || 3000;

// 1. Configuración de MercadoPago (Usando SDK v3)
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
  options: { timeout: 5000, sandbox: process.env.NODE_ENV === "development" }
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

console.log(`Mercado Pago SDK inicializado en modo ${process.env.NODE_ENV === "development" ? 'Sandbox' : 'Producción'}`);

// --- SECCIÓN FIREBASE REACTIVADA ---
// 2. Configuración de Firebase Admin SDK
const base64EncodedServiceAccount = process.env.BASE64_ENCODED_SERVICE_ACCOUNT;

if (!base64EncodedServiceAccount) {
  console.error("ERROR FATAL: La variable de entorno BASE64_ENCODED_SERVICE_ACCOUNT no está definida.");
  process.exit(1); // Termina si no hay credenciales de Firebase
}

let db; // Declarar db fuera del try para que esté disponible globalmente en este módulo
try {
  const decodedServiceAccount = Buffer.from(base64EncodedServiceAccount, 'base64').toString('utf-8');
  const serviceAccount = JSON.parse(decodedServiceAccount);

  // Evitar reinicializar Firebase si ya existe una app
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      // Opcional: Especificar databaseURL si usas Realtime Database además de Firestore
      // databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
    console.log("Firebase Admin SDK inicializado por primera vez.");
  } else {
    console.log("Firebase Admin SDK ya estaba inicializado.");
  }

  db = admin.firestore(); // Obtener instancia de Firestore
  console.log("Instancia de Firestore obtenida.");

} catch (error) {
   console.error("ERROR FATAL: No se pudo inicializar Firebase Admin SDK o obtener Firestore.", error);
   process.exit(1);
}
// --- FIN SECCIÓN FIREBASE REACTIVADA ---


// --- 3. Endpoints de la API ---

// Endpoint raíz de prueba
app.get("/", (req, res) => {
  res.send("Backend MercadoPago v2 para Vending (CON FIRESTORE) 🚀");
});

// Endpoint para crear la preferencia de pago (y obtener init_point)
app.post("/create-payment", async (req, res) => {
  console.log("Recibida petición /create-payment:", JSON.stringify(req.body, null, 2));
  try {
    const { machine_id, items } = req.body;

    if (!machine_id || !items || !Array.isArray(items) || items.length === 0) {
      console.warn("Petición /create-payment rechazada por datos faltantes:", { machine_id, items_type: typeof items, items_length: items?.length });
      return res.status(400).json({ error: "Faltan datos requeridos: machine_id y/o items válidos." });
    }

    // Log crucial para verificar la URL de notificación
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
      notification_url: constructedNotificationUrl, // Usar la variable logueada
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

    const transactionData = {
      machine_id: machine_id,
      status: "pending", // Estado inicial
      items: items,
      mp_preference_id: preference.id,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection("transactions").doc(preference.id).set(transactionData);
    console.log(`Transacción inicial guardada en Firestore con ID: ${preference.id}`);

    res.json({
      id: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point
    });

  } catch (error) {
    console.error("Error al crear preferencia de pago:", error.cause || error.message || error);
    const errorDetails = error.cause ? JSON.stringify(error.cause, null, 2) : error.message;
    res.status(500).json({ error: "No se pudo crear la preferencia de pago.", details: errorDetails });
  }
});

// --- WEBHOOK CON LÓGICA DE FIRESTORE REACTIVADA Y AJUSTADA ---
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
     console.log("Notificación ignorada o ID de pago no encontrado.");
     console.log(`--- [${new Date().toISOString()}] FIN Webhook (Ignorado/ID no encontrado) ---`);
     return res.sendStatus(200);
  }

  try {
    console.log(`[TRY] Procesando notificación para Payment ID: ${paymentId}`);
    console.log(`[TRY] Llamando a paymentClient.get({ id: ${paymentId} })...`);
    const payment = await paymentClient.get({ id: paymentId });
    console.log(`[TRY] Llamada a paymentClient.get completada.`);

    if (!payment) {
        console.error(`[TRY] No se encontraron detalles en MP para el Payment ID: ${paymentId} (Respuesta vacía de SDK?)`);
        console.log(`--- [${new Date().toISOString()}] FIN Webhook (Error: Pago no encontrado en MP) ---`);
        return res.sendStatus(200);
    }

    const externalReference = payment.external_reference;
    const paymentStatus = payment.status;
    const preferenceId = payment.preference_id;

    console.log(`[TRY] Estado verificado para Pago ${paymentId} (Pref ID: ${preferenceId}, Ref Ext: ${externalReference}): ${paymentStatus}`);

    if (!db) { // Chequeo por si db no se inicializó (aunque debería haber salido antes)
        console.error("[TRY] ERROR CRÍTICO: Instancia de Firestore 'db' no está disponible.");
        return res.status(500).send("Error interno del servidor: Firestore no disponible.");
    }

    if (!preferenceId) {
        console.error(`[TRY] ERROR CRÍTICO: Payment ID ${paymentId} no tiene preference_id asociado. No se puede encontrar la transacción en Firestore.`);
        console.log(`--- [${new Date().toISOString()}] FIN Webhook (Error: Sin preference_id) ---`);
        return res.sendStatus(200);
    }

    const transactionRef = db.collection("transactions").doc(preferenceId);
    console.log(`[TRY] Obteniendo documento de Firestore: transactions/${preferenceId}`);
    const transactionDoc = await transactionRef.get();

    if (!transactionDoc.exists) {
         console.error(`[TRY] ERROR CRÍTICO: No se encontró transacción en Firestore con Preference ID: ${preferenceId} (corresponde a Payment ID ${paymentId}, External Ref ${externalReference})`);
         console.log(`--- [${new Date().toISOString()}] FIN Webhook (Error: Documento no existe en Firestore) ---`);
         return res.sendStatus(200);
    }

    console.log(`[TRY] Transacción encontrada en Firestore con Preference ID: ${preferenceId}.`);
    const currentStatus = transactionDoc.data()?.status;
    console.log(`[TRY] Estado actual en Firestore: ${currentStatus}, Estado de MP: ${paymentStatus}`);

    if (currentStatus !== paymentStatus) {
        console.log(`[TRY] Actualizando estado de '${currentStatus}' a '${paymentStatus}' para orden con Pref ID ${transactionRef.id} (Ref externa: ${externalReference}).`);
        const updateData = {
          mp_payment_id: payment.id,
          status: paymentStatus,
          payment_status_detail: payment.status_detail,
          payment_details: {
             date_created: payment.date_created,
             date_approved: payment.date_approved,
             date_last_updated: payment.date_last_updated,
             payer_email: payment.payer?.email,
             payment_method_id: payment.payment_method_id,
             payment_type_id: payment.payment_type_id,
             transaction_amount: payment.transaction_amount,
             currency_id: payment.currency_id,
             installments: payment.installments,
          },
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        await transactionRef.update(updateData);
        console.log(`[TRY] ✅ Actualización en Firestore completada para ${transactionRef.id}. Nuevo estado: ${paymentStatus}`);

        if (paymentStatus === 'approved') {
            const machineId = externalReference;
            console.log(`[TRY] 🚀 EJECUTANDO ACCIONES POST-PAGO APROBADO para Pref ${transactionRef.id} (Machine: ${machineId})...`);
            try {
                console.log(`[TRY]    -> Acción específica para máquina ${machineId} (ej: marcar como lista para dispensar).`);
            } catch (postPagoError) {
                console.error(`[TRY] Error ejecutando acciones post-pago para ${transactionRef.id}:`, postPagoError);
            }
        }
    } else {
         console.log(`[TRY] Estado ${paymentStatus} para ${transactionRef.id} ya estaba registrado. No se requiere actualización.`);
    }

    console.log(`[TRY] Enviando respuesta 200 OK a Mercado Pago...`);
    res.sendStatus(200);
    console.log(`--- [${new Date().toISOString()}] FIN Webhook (Procesado OK) ---`);

  } catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("!!!!!!!!    Error en CATCH procesando webhook    !!!!!!!!!");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    if (error.cause) {
         console.error("Error Cause:", JSON.stringify(error.cause, null, 2));
    } else {
         console.error("Error Object:", error);
    }
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    const statusCode = error.statusCode || 500;
    console.log(`[CATCH] Enviando respuesta ${statusCode} a Mercado Pago...`);
    res.sendStatus(statusCode);
    console.log(`--- [${new Date().toISOString()}] FIN Webhook (Error en Catch) ---`);
  }
});
// --- FIN DEL WEBHOOK CON FIRESTORE ---

// --- Iniciar el Servidor ---
app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en puerto ${PORT}`);
  console.log(`URL Base (asegúrate que BACKEND_URL sea pública para webhooks): ${process.env.BACKEND_URL || 'URL NO DEFINIDA -> ¡WEBHOOKS FALLARÁN!'}`);
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) console.error("ALERTA: MERCADOPAGO_ACCESS_TOKEN no está definido.");
  if (!process.env.BASE64_ENCODED_SERVICE_ACCOUNT) console.error("ALERTA: BASE64_ENCODED_SERVICE_ACCOUNT no está definido (Firestore no funcionará).");
  if (!process.env.FRONTEND_URL) console.warn("ADVERTENCIA: FRONTEND_URL no está definido (back_urls podrían fallar).");
  console.log("INFO: Interacción con Firestore HABILITADA en este código.");
});
