// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3 de Mercado Pago
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin"); // Firebase Admin SDK

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

// 2. Configuración de Firebase Admin SDK
// Asegúrate de tener BASE64_ENCODED_SERVICE_ACCOUNT en tu archivo .env
const base64EncodedServiceAccount = process.env.BASE64_ENCODED_SERVICE_ACCOUNT;

if (!base64EncodedServiceAccount) {
  console.error("ERROR FATAL: La variable de entorno BASE64_ENCODED_SERVICE_ACCOUNT no está definida.");
  process.exit(1); // Termina si no hay credenciales de Firebase
}

try {
  const decodedServiceAccount = Buffer.from(base64EncodedServiceAccount, 'base64').toString('utf-8');
  const serviceAccount = JSON.parse(decodedServiceAccount);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // Opcional: Especificar databaseURL si usas Realtime Database además de Firestore
    // databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
  });

  const db = admin.firestore();
  console.log("Firebase Admin SDK inicializado correctamente.");

} catch (error) {
   console.error("ERROR FATAL: No se pudo inicializar Firebase Admin SDK.", error);
   process.exit(1);
}

const db = admin.firestore(); // Obtener instancia de Firestore

// --- 3. Endpoints de la API ---

// Endpoint raíz de prueba
app.get("/", (req, res) => {
  res.send("Backend MercadoPago v2 para Vending 🚀");
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
        id: item.id || undefined, // Opcional: ID del item en tu sistema
        title: item.name ? item.name.substring(0, 250) : 'Producto', // Título descriptivo, con límite MP
        description: item.description || undefined, // Opcional
        quantity: Number(item.quantity),
        currency_id: "MXN", // Moneda (ajustar si es necesario)
        unit_price: Number(item.price)
      })),
      // Usar machine_id como referencia externa es válido si identifica unívocamente la transacción
      // Si una máquina puede tener múltiples transacciones simultáneas, considera un ID único de transacción
      external_reference: machine_id,
      // URL pública donde Mercado Pago enviará notificaciones (webhooks)
      notification_url: `${process.env.BACKEND_URL}/payment-webhook`,
      // URLs a donde redirigir al usuario si paga desde un navegador (menos relevante para QR puro)
      back_urls: {
        success: `${process.env.FRONTEND_URL}/success?machine_id=${machine_id}`, // Puedes pasar datos en la URL
        failure: `${process.env.FRONTEND_URL}/error?machine_id=${machine_id}`,
        pending: `${process.env.FRONTEND_URL}/pending?machine_id=${machine_id}` // Si aplica
      },
      auto_return: "approved" // Redirigir automáticamente en caso de éxito
    };

     console.log("Creando preferencia con datos:", JSON.stringify(preferenceBody, null, 2));

    // Llamada a la API de Mercado Pago para crear la preferencia
    const preference = await preferenceClient.create({ body: preferenceBody });

    console.log("Preferencia creada exitosamente:", preference.id);

    // Guardar registro inicial en Firestore usando preference.id como ID del documento
    // Esto permite encontrarlo fácilmente desde el webhook usando payment.preference_id
    const transactionData = {
      machine_id: machine_id,
      status: "pending", // Estado inicial
      items: items, // Guardar los items de esta transacción
      mp_preference_id: preference.id, // Guardar el ID de la preferencia
      created_at: admin.firestore.FieldValue.serverTimestamp()
      // Considera guardar el monto total calculado aquí para validaciones
    };
    await db.collection("transactions").doc(preference.id).set(transactionData);
    console.log(`Transacción inicial guardada en Firestore con ID: ${preference.id}`);

    // Devolver ID de preferencia y los init_points al frontend
    // El frontend usará el init_point adecuado (sandbox o producción) para generar el QR
    res.json({
      id: preference.id,
      init_point: preference.init_point, // Para producción
      sandbox_init_point: preference.sandbox_init_point // Para desarrollo/sandbox
    });

  } catch (error) {
    console.error("Error al crear preferencia de pago:", error.cause || error.message || error);
    // Devolver un mensaje de error genérico o específico si es seguro
    res.status(500).json({ error: "No se pudo crear la preferencia de pago.", details: error.message });
  }
});

// Endpoint para recibir Webhooks de Mercado Pago (CON LÓGICA REFINADA)
app.post("/payment-webhook", async (req, res) => {
  // Loguear el cuerpo completo puede ser útil en desarrollo
  console.log("Webhook recibido:", JSON.stringify(req.body, null, 2));

  // Mercado Pago puede usar 'type' o 'topic' para el tipo de evento
  const notificationType = req.body.type || req.body.topic;

  // Ignorar notificaciones que no sean de pago o no tengan ID
  if (notificationType !== 'payment' || !req.body?.data?.id) {
     console.log("Notificación ignorada (tipo:", notificationType, "ID:", req.body?.data?.id, ")");
     // Responder 200 OK para que MP no reintente notificaciones irrelevantes
     return res.sendStatus(200);
  }

  try {
    const paymentId = req.body.data.id;
    console.log(`Procesando notificación para Payment ID: ${paymentId}`);

    // 1. Obtener detalles completos y verificados del pago desde Mercado Pago
    const payment = await paymentClient.get({ id: paymentId });

    if (!payment) {
        console.error(`No se encontraron detalles en MP para el Payment ID: ${paymentId}`);
        // Aún así responder 200 para evitar reintentos de MP por algo que no encontramos
        return res.sendStatus(200);
    }
     console.log(`Detalles del pago ${paymentId} obtenidos de MP: Status ${payment.status}`);
    // console.log("Detalles completos del pago:", JSON.stringify(payment, null, 2)); // Descomentar para debug profundo


    // 2. Identificar la transacción en Firestore usando el preference_id del pago
    const preferenceId = payment.preference_id;
    const externalReference = payment.external_reference; // Útil para logs y lógica de negocio

    if (!preferenceId) {
        // Esto sería raro para Checkout Pro, pero manejarlo por si acaso
        console.error(`ERROR CRÍTICO: Payment ID ${paymentId} no tiene preference_id asociado. No se puede encontrar la transacción en Firestore.`);
        // Responder 200 para evitar reintentos de MP si no podemos hacer nada
        return res.sendStatus(200);
    }

    // Referencia al documento en Firestore (usando el ID con el que se guardó originalmente)
    const transactionRef = db.collection("transactions").doc(preferenceId);
    const transactionDoc = await transactionRef.get();

    if (!transactionDoc.exists) {
         console.error(`ERROR CRÍTICO: No se encontró transacción en Firestore con Preference ID: ${preferenceId} (corresponde a Payment ID ${paymentId}, External Ref ${externalReference})`);
         // Responder 200 para evitar reintentos de MP
         return res.sendStatus(200);
    }

    console.log(`Transacción encontrada en Firestore con Preference ID: ${preferenceId}`);
    const currentStatus = transactionDoc.data()?.status; // Obtener estado actual para evitar reprocesar

    // 3. Actualizar el documento encontrado en Firestore con datos verificados
    //    Evita sobrescribir toda la data original, solo actualiza campos relevantes.
    //    ¡Importante! Considera no actualizar si el estado ya es final (approved, cancelled, rejected)
    //    para evitar lógica duplicada si MP envía múltiples webhooks para el mismo estado.
    if (currentStatus !== payment.status) { // Solo actualiza si el estado cambió
        console.log(`Actualizando estado de ${currentStatus} a ${payment.status} para ${transactionRef.id}`);
        const updateData = {
          mp_payment_id: payment.id,             // Guardar el ID del pago de MP
          status: payment.status,                // Estado verificado del pago
          payment_status_detail: payment.status_detail, // Detalle del estado
          // Guardar detalles relevantes del pago, no necesariamente todo el objeto payment
          payment_details: {
             date_created: payment.date_created, // Fecha de creación del pago en MP
             date_approved: payment.date_approved, // Fecha de aprobación (si aplica)
             date_last_updated: payment.date_last_updated, // Fecha de última actualización en MP
             payer_email: payment.payer?.email, // Email del pagador (si disponible)
             payment_method_id: payment.payment_method_id, // Ej: 'visa', 'master', 'oxxo'
             payment_type_id: payment.payment_type_id, // Ej: 'credit_card', 'ticket', 'account_money'
             transaction_amount: payment.transaction_amount, // Monto total pagado
             currency_id: payment.currency_id, // Moneda
             installments: payment.installments, // Cuotas (si aplica)
             // Puedes añadir otros campos si los necesitas: card.last_four_digits, etc.
          },
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        await transactionRef.update(updateData);
        console.log(`✅ Transacción ${transactionRef.id} (Payment ${paymentId}) actualizada en Firestore a: ${payment.status}`);

        // 4. Lógica Post-Pago (SOLO si el estado es APROBADO y no lo habíamos procesado antes)
        if (payment.status === 'approved') {
            const machineId = externalReference; // Recuperamos el ID de la máquina
            console.log(`🚀 EJECUTANDO ACCIONES POST-PAGO APROBADO para Pref ${transactionRef.id} (Machine: ${machineId})...`);
            // Aquí llamas a la función que necesites para tu lógica de negocio
            // Ejemplo: notificar a la máquina vending que libere el producto
            // await notificarMaquinaVending(machineId, transactionRef.id, payment.items);
            // O actualizar otro estado en Firestore/Realtime Database
            try {
                // --- INICIO Lógica específica post-pago ---
                // Ejemplo: Actualizar un estado en la máquina o enviar una señal
                // await db.collection('machines').doc(machineId).update({ last_sale_status: 'approved', needs_dispense: true });
                console.log(`   -> Acción simulada para máquina ${machineId}: Marcar como lista para dispensar.`);
                // --- FIN Lógica específica post-pago ---
            } catch (postPagoError) {
                console.error(`Error ejecutando acciones post-pago para ${transactionRef.id}:`, postPagoError);
                // Considera cómo manejar errores aquí (¿reintentar? ¿loguear?)
            }
        }
    } else {
         console.log(`Estado ${payment.status} para ${transactionRef.id} ya estaba registrado. No se requiere actualización.`);
    }


    // 5. ¡Importante responder 200 OK a Mercado Pago!
    res.sendStatus(200);

  } catch (error) {
    console.error("Error procesando webhook:", error);
    // Devolver 500 hará que Mercado Pago reintente la notificación.
    // Decide si prefieres reintentos o manejar el error internamente y devolver 200.
    // Si el error es temporal (ej. DB inaccesible), 500 puede ser útil.
    // Si es un error permanente (ej. dato inválido), mejor 200 para parar reintentos.
    res.sendStatus(500); // Puedes cambiar a 200 si no quieres reintentos en caso de error interno.
  }
});


// --- Iniciar el Servidor ---
app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en puerto ${PORT}`);
  console.log(`URL Base (asegúrate que BACKEND_URL sea pública para webhooks): ${process.env.BACKEND_URL || 'URL NO DEFINIDA'}`);
});
