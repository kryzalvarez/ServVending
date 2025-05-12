// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3 de Mercado Pago
const cors = require("cors");
const bodyParser = require("body-parser");
// const admin = require("firebase-admin"); // Firebase Admin SDK - Comentado/Eliminado temporalmente

// Inicialización de Express
const app = express();

// Middlewares
app.use(cors()); // Habilita CORS para permitir peticiones del frontend
app.use(bodyParser.json()); // Parsea cuerpos de petición JSON

// Puerto del servidor
const PORT = process.env.PORT || 3000;

// 1. Configuración de MercadoPago (Usando SDK v3)
// Asegúrate de tener MERCADOPAGO_ACCESS_TOKEN en tu archivo .env
// y NODE_ENV=development o production para el modo sandbox
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
  options: { timeout: 5000, sandbox: process.env.NODE_ENV === "development" } // Añadido timeout y sandbox explícito
});

// Clientes específicos para Preferencias y Pagos
const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

console.log(`Mercado Pago SDK inicializado en modo ${process.env.NODE_ENV === "development" ? 'Sandbox' : 'Producción'}`);

/* --- SECCIÓN FIREBASE COMENTADA/ELIMINADA ---
// 2. Configuración de Firebase Admin SDK
const base64EncodedServiceAccount = process.env.BASE64_ENCODED_SERVICE_ACCOUNT;

if (!base64EncodedServiceAccount) {
  console.error("ERROR FATAL: La variable de entorno BASE64_ENCODED_SERVICE_ACCOUNT no está definida.");
  process.exit(1);
}

try {
  const decodedServiceAccount = Buffer.from(base64EncodedServiceAccount, 'base64').toString('utf-8');
  const serviceAccount = JSON.parse(decodedServiceAccount);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  const db = admin.firestore();
  console.log("Firebase Admin SDK inicializado correctamente.");

} catch (error) {
   console.error("ERROR FATAL: No se pudo inicializar Firebase Admin SDK.", error);
   process.exit(1);
}

const db = admin.firestore(); // Obtener instancia de Firestore
------------------------------------------- */
console.log("ADVERTENCIA: Interacción con Firestore deshabilitada en este código.");


// --- 3. Endpoints de la API ---

// Endpoint raíz de prueba
app.get("/", (req, res) => {
  res.send("Backend MercadoPago v2 para Vending (SIN FIRESTORE) 🚀");
});

// Endpoint para crear la preferencia de pago (y obtener init_point)
app.post("/create-payment", async (req, res) => {
  console.log("Recibida petición /create-payment:", req.body);
  try {
    const { machine_id, items } = req.body;

    // Validación básica de entrada
    if (!machine_id || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Faltan datos requeridos: machine_id y/o items válidos." });
    }

    // Construcción del cuerpo de la preferencia
    const preferenceBody = {
      items: items.map(item => ({
        id: item.id || undefined,
        title: item.name ? item.name.substring(0, 250) : 'Producto',
        description: item.description || undefined,
        quantity: Number(item.quantity),
        currency_id: "MXN", // Moneda
        unit_price: Number(item.price)
      })),
      external_reference: machine_id,
      notification_url: `${process.env.BACKEND_URL}/payment-webhook`, // ¡IMPORTANTE! Debe ser pública
      back_urls: {
        success: `${process.env.FRONTEND_URL}/success?machine_id=${machine_id}`,
        failure: `${process.env.FRONTEND_URL}/error?machine_id=${machine_id}`,
        pending: `${process.env.FRONTEND_URL}/pending?machine_id=${machine_id}`
      },
      auto_return: "approved"
    };

     console.log("Creando preferencia con datos:", JSON.stringify(preferenceBody, null, 2));

    // Llamada a la API de Mercado Pago para crear la preferencia
    const preference = await preferenceClient.create({ body: preferenceBody });

    console.log("Preferencia creada exitosamente:", preference.id);

    /* --- GUARDADO EN FIRESTORE COMENTADO/ELIMINADO ---
    const transactionData = {
      machine_id: machine_id,
      status: "pending",
      items: items,
      mp_preference_id: preference.id,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection("transactions").doc(preference.id).set(transactionData);
    console.log(`Transacción inicial guardada en Firestore con ID: ${preference.id}`);
    ------------------------------------------------- */
    console.log(`ADVERTENCIA: NO se guardó la transacción inicial en Firestore (función deshabilitada).`);


    // Devolver ID de preferencia y los init_points al frontend
    res.json({
      id: preference.id,
      init_point: preference.init_point, // Para producción
      sandbox_init_point: preference.sandbox_init_point // Para desarrollo/sandbox
    });

  } catch (error) {
    console.error("Error al crear preferencia de pago:", error.cause || error.message || error);
    res.status(500).json({ error: "No se pudo crear la preferencia de pago.", details: error.message });
  }
});

// --- WEBHOOK MODIFICADO PARA SIMULAR Y LOGUEAR COMO PYTHON (SIN FIRESTORE) ---
app.post("/payment-webhook", async (req, res) => {
  // Loguear el cuerpo completo puede ser útil en desarrollo
  console.log("Webhook recibido:", JSON.stringify(req.body, null, 2));

  // Mercado Pago puede usar 'type' o 'topic' para el tipo de evento
  const notificationType = req.body.type || req.body.topic;

  // Ignorar notificaciones que no sean de pago o no tengan ID
  if (notificationType !== 'payment' || !req.body?.data?.id) {
     console.log("Notificación ignorada (tipo:", notificationType, "ID:", req.body?.data?.id, ")");
     return res.sendStatus(200);
  }

  try {
    const paymentId = req.body.data.id;
    console.log(`Procesando notificación para Payment ID: ${paymentId}`);

    // 1. Obtener detalles completos y verificados del pago desde Mercado Pago (SE MANTIENE)
    const payment = await paymentClient.get({ id: paymentId });

    if (!payment) {
        console.error(`No se encontraron detalles en MP para el Payment ID: ${paymentId}`);
        return res.sendStatus(200); // Responder OK para evitar reintentos
    }
    // --- Log de Verificación (Idéntico al formato Python solicitado) ---
    const externalReference = payment.external_reference; // Obtener referencia externa (machine_id)
    const paymentStatus = payment.status; // Obtener estado
    console.log(`Estado verificado para Pago ${paymentId} (Ref: ${externalReference}): ${paymentStatus}`);


    // 2. Simular búsqueda de orden local (SIN FIRESTORE)
    // --- Log de Búsqueda (Idéntico al formato Python solicitado) ---
    console.log(`Buscando orden local con external_reference: ${externalReference}`);
    // (No hay acción real de búsqueda aquí)
    // console.log(`   -> Orden encontrada (simulación).`); // Log adicional opcional


    // 3. Simular actualización de estado local (SIN FIRESTORE)
    // --- Log de Actualización (Idéntico al formato Python solicitado) ---
    console.log(`Simulando actualización de estado local a '${paymentStatus}' para orden ${externalReference}`);
    // (No hay acción real de actualización aquí)


    // 4. Simular Lógica Post-Pago (SIN FIRESTORE)
    if (paymentStatus === 'approved') {
        const machineId = externalReference; // Es tu machine_id
        console.log(`🚀 EJECUTANDO ACCIONES POST-PAGO APROBADO para Orden ${externalReference} (Machine: ${machineId})...`);
        try {
            // --- INICIO Lógica específica post-pago (SIN FIRESTORE) ---
            console.log(`   -> Acción simulada para máquina ${machineId}: Marcar como lista para dispensar.`);
            // --- FIN Lógica específica post-pago ---
        } catch (postPagoError) {
            console.error(`Error simulando acciones post-pago para ${externalReference}:`, postPagoError);
        }
    }


    // 5. ¡Importante responder 200 OK a Mercado Pago! (SE MANTIENE)
    res.sendStatus(200);

  } catch (error) {
    console.error("Error procesando webhook:", error);
    res.sendStatus(500); // Mantener respuesta de error si falla la verificación de MP, etc.
  }
});
// --- FIN DEL WEBHOOK MODIFICADO ---


// --- Iniciar el Servidor ---
app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en puerto ${PORT}`);
  console.log(`URL Base (asegúrate que BACKEND_URL sea pública para webhooks): ${process.env.BACKEND_URL || 'URL NO DEFINIDA'}`);
  console.log("ADVERTENCIA: La interacción con Firestore está DESHABILITADA en este código.");
});
