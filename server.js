// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3 de Mercado Pago
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin"); // <<<--- DESCOMENTADO: Firebase Admin SDK

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

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // Opcional: Especificar databaseURL si usas Realtime Database además de Firestore
    // databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
  });

  db = admin.firestore(); // <<<--- DESCOMENTADO: Obtener instancia de Firestore
  console.log("Firebase Admin SDK inicializado correctamente.");

} catch (error) {
   console.error("ERROR FATAL: No se pudo inicializar Firebase Admin SDK.", error);
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
  console.log("Recibida petición /create-payment:", req.body);
  try {
    const { machine_id, items } = req.body;

    if (!machine_id || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Faltan datos requeridos: machine_id y/o items válidos." });
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
      notification_url: `${process.env.BACKEND_URL}/payment-webhook`,
      back_urls: {
        success: `${process.env.FRONTEND_URL}/success?machine_id=${machine_id}`,
        failure: `${process.env.FRONTEND_URL}/error?machine_id=${machine_id}`,
        pending: `${process.env.FRONTEND_URL}/pending?machine_id=${machine_id}`
      },
      auto_return: "approved"
    };

     console.log("Creando preferencia con datos:", JSON.stringify(preferenceBody, null, 2));
    const preference = await preferenceClient.create({ body: preferenceBody });
    console.log("Preferencia creada exitosamente:", preference.id);

    // --- GUARDADO EN FIRESTORE REACTIVADO ---
    const transactionData = {
      machine_id: machine_id,
      status: "pending", // Estado inicial
      items: items, // Guardar los items de esta transacción
      mp_preference_id: preference.id, // Guardar el ID de la preferencia
      created_at: admin.firestore.FieldValue.serverTimestamp()
      // Considera guardar el monto total calculado aquí para validaciones
    };
    // Usar preference.id como ID del documento en Firestore
    await db.collection("transactions").doc(preference.id).set(transactionData);
    console.log(`Transacción inicial guardada en Firestore con ID: ${preference.id}`);
    // --- FIN GUARDADO EN FIRESTORE REACTIVADO ---

    res.json({
      id: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point
    });

  } catch (error) {
    console.error("Error al crear preferencia de pago:", error.cause || error.message || error);
    res.status(500).json({ error: "No se pudo crear la preferencia de pago.", details: error.message });
  }
});

// --- WEBHOOK CON LÓGICA DE FIRESTORE REACTIVADA Y AJUSTADA ---
app.post("/payment-webhook", async (req, res) => {
  console.log("Webhook recibido:", JSON.stringify(req.body, null, 2));

  const notificationType = req.body.type || req.body.topic;

  if (notificationType !== 'payment' || !req.body?.data?.id) {
     console.log("Notificación ignorada (tipo:", notificationType, "ID:", req.body?.data?.id, ")");
     return res.sendStatus(200);
  }

  try {
    const paymentId = req.body.data.id;
    console.log(`Procesando notificación para Payment ID: ${paymentId}`);

    // 1. Obtener detalles completos y verificados del pago desde Mercado Pago
    const payment = await paymentClient.get({ id: paymentId });

    if (!payment) {
        console.error(`No se encontraron detalles en MP para el Payment ID: ${paymentId}`);
        return res.sendStatus(200);
    }

    const externalReference = payment.external_reference;
    const paymentStatus = payment.status;
    const preferenceId = payment.preference_id; // Crucial para encontrar el doc en Firestore

    console.log(`Estado verificado para Pago ${paymentId} (Pref ID: ${preferenceId}, Ref Ext: ${externalReference}): ${paymentStatus}`);

    if (!preferenceId) {
        console.error(`ERROR CRÍTICO: Payment ID ${paymentId} no tiene preference_id asociado. No se puede encontrar la transacción en Firestore.`);
        return res.sendStatus(200);
    }

    // 2. Referencia al documento en Firestore
    // (Se guardó usando preference.id, que es lo que MP devuelve como payment.preference_id)
    const transactionRef = db.collection("transactions").doc(preferenceId);
    const transactionDoc = await transactionRef.get();

    if (!transactionDoc.exists) {
         console.error(`ERROR CRÍTICO: No se encontró transacción en Firestore con Preference ID: ${preferenceId} (corresponde a Payment ID ${paymentId}, External Ref ${externalReference})`);
         return res.sendStatus(200);
    }

    console.log(`Transacción encontrada en Firestore con Preference ID: ${preferenceId}`);
    const currentStatus = transactionDoc.data()?.status;

    // 3. Actualizar el documento en Firestore si el estado ha cambiado
    if (currentStatus !== paymentStatus) {
        console.log(`Actualizando estado de '${currentStatus}' a '${paymentStatus}' para orden con Pref ID ${transactionRef.id} (Ref externa: ${externalReference}).`);
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
        console.log(`✅ Actualización en Firestore completada para ${transactionRef.id}. Nuevo estado: ${paymentStatus}`);

        // 4. Lógica Post-Pago (si fue aprobado y es la primera vez que se procesa como aprobado)
        if (paymentStatus === 'approved') {
            const machineId = externalReference;
            console.log(`🚀 EJECUTANDO ACCIONES POST-PAGO APROBADO para Pref ${transactionRef.id} (Machine: ${machineId})...`);
            try {
                // Aquí va tu lógica real para notificar a la máquina vending o similar
                console.log(`   -> Acción específica para máquina ${machineId} (ej: marcar como lista para dispensar).`);
                // Ejemplo: await db.collection('machines').doc(machineId).update({ last_payment_approved: true, dispense_pending: true });
            } catch (postPagoError) {
                console.error(`Error ejecutando acciones post-pago para ${transactionRef.id}:`, postPagoError);
            }
        }
    } else {
         console.log(`Estado ${paymentStatus} para ${transactionRef.id} ya estaba registrado. No se requiere actualización.`);
    }

    // 5. Responder 200 OK a Mercado Pago
    res.sendStatus(200);

  } catch (error) {
    console.error("Error procesando webhook:", error.cause || error.message || error);
    res.sendStatus(500);
  }
});
// --- FIN DEL WEBHOOK CON FIRESTORE ---


// --- Iniciar el Servidor ---
app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en puerto ${PORT}`);
  console.log(`URL Base (asegúrate que BACKEND_URL sea pública para webhooks): ${process.env.BACKEND_URL || 'URL NO DEFINIDA'}`);
  console.log("INFO: Interacción con Firestore HABILITADA en este código.");
});
