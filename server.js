// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3 de Mercado Pago
const cors = require("cors");
const bodyParser = require("body-parser");
// Firebase Admin SDK no se usa en esta versión de polling
// const admin = require("firebase-admin");

// Inicialización de Express
const app = express();

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Puerto del servidor
const PORT = process.env.PORT || 3000;

// Configuración de MercadoPago
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
  options: { timeout: 5000, sandbox: process.env.NODE_ENV === "development" }
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

console.log(`Mercado Pago SDK inicializado en modo ${process.env.NODE_ENV === "development" ? 'Sandbox' : 'Producción'}`);
console.log("INFO: Este backend usará HTTP Polling (sin Firestore).");

// --- Almacenamiento en memoria para estados de pago (SIMPLIFICADO) ---
// ADVERTENCIA: Se pierde si el servidor/instancia se reinicia.
// En un entorno de producción real, usa una base de datos persistente.
let paymentStatuses = {};
// Limpieza periódica de estados viejos (opcional, para evitar que crezca indefinidamente)
setInterval(() => {
    const now = Date.now();
    Object.keys(paymentStatuses).forEach(key => {
        // Eliminar entradas más viejas de, por ejemplo, 1 hora
        if (paymentStatuses[key].createdAt && (now - new Date(paymentStatuses[key].createdAt).getTime()) > 3600000) {
            console.log(`Limpiando estado de preferencia antigua: ${key}`);
            delete paymentStatuses[key];
        }
    });
}, 600000); // Cada 10 minutos

// --- Endpoints de la API ---

app.get("/", (req, res) => {
  res.send("Backend MercadoPago v2 para Vending (CON HTTP POLLING) 🚀");
});

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

    // Guardar estado inicial para el polling
    paymentStatuses[preference.id] = {
      status: "pending",
      machine_id: machine_id, // machine_id es external_reference
      items: items, // Guardar items si la app Android los necesita en la respuesta de polling
      createdAt: new Date().toISOString(),
      mp_preference_id: preference.id // Guardar el ID de la preferencia
    };
    console.log(`Estado inicial para ${preference.id} ("pending") guardado para polling.`);

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

    const payment = await paymentClient.get({ id: paymentId });

    if (!payment) {
        console.error(`No se encontraron detalles en MP para el Payment ID: ${paymentId}`);
        return res.sendStatus(200);
    }

    const externalReference = payment.external_reference;
    const paymentStatus = payment.status;
    const preferenceId = payment.preference_id; // Crucial para encontrar la transacción

    console.log(`Estado verificado para Pago ${paymentId} (Pref ID: ${preferenceId}, Ref Ext: ${externalReference}): ${paymentStatus}`);

    // Actualizar estado en nuestro almacenamiento en memoria
    if (paymentStatuses[preferenceId]) {
      paymentStatuses[preferenceId].status = paymentStatus;
      paymentStatuses[preferenceId].mp_payment_id = paymentId; // Guardar ID de pago de MP
      paymentStatuses[preferenceId].payment_status_detail = payment.status_detail;
      // Podrías guardar más detalles si los necesitas
      // paymentStatuses[preferenceId].payment_details = { ... };
      paymentStatuses[preferenceId].updatedAt = new Date().toISOString();
      console.log(`Estado para ${preferenceId} actualizado a ${paymentStatus} en 'paymentStatuses'.`);
    } else {
      // Si no existe, lo creamos. Podría pasar si el webhook llega muy rápido.
      console.warn(`No se encontró estado inicial para polling para preference_id: ${preferenceId}. Creando entrada.`);
      paymentStatuses[preferenceId] = {
          status: paymentStatus,
          machine_id: externalReference,
          mp_payment_id: paymentId,
          payment_status_detail: payment.status_detail,
          createdAt: payment.date_created || new Date().toISOString(), // Usar fecha de MP si está
          updatedAt: new Date().toISOString(),
          items: payment.additional_info?.items || []
      };
    }

    if (paymentStatus === 'approved') {
        const machineId = externalReference;
        console.log(`🚀 EJECUTANDO ACCIONES POST-PAGO APROBADO para Orden ${externalReference} (Machine: ${machineId})...`);
        // Lógica que necesites ejecutar en el backend inmediatamente (si alguna)
        console.log(`   -> Acción simulada para máquina ${machineId}: Marcar como lista para dispensar (backend).`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error procesando webhook:", error.cause || error.message || error);
    res.sendStatus(500);
  }
});

// --- NUEVO ENDPOINT PARA QUE LA APP ANDROID HAGA POLLING ---
app.get("/payment-status", (req, res) => {
  const preferenceId = req.query.preference_id; // Recibimos el ID como query parameter

  if (!preferenceId) {
    return res.status(400).json({ error: "Falta el parámetro 'preference_id'." });
  }
  console.log(`Solicitud de estado (polling) para preference_id: ${preferenceId}`);

  const transaction = paymentStatuses[preferenceId];

  if (!transaction) {
    // Si no se encuentra, es posible que la preferencia aún no se haya registrado o sea inválida.
    // La app Android debería manejar este caso y reintentar o mostrar un error.
    return res.status(404).json({
        preference_id: preferenceId,
        status: "not_found", // Un estado especial para que la app sepa que no existe (aún)
        message: "Transacción no encontrada. Puede que aún no se haya creado o el ID sea incorrecto."
    });
  }

  // Devolver el estado actual y cualquier otra información útil para la app
  console.log(`Devolviendo estado para ${preferenceId}: ${transaction.status}`);
  res.json({
    preference_id: preferenceId,
    status: transaction.status,
    machine_id: transaction.machine_id, // machine_id (external_reference)
    // Podrías devolver más detalles si la app los necesita, como los items
    // items: transaction.items,
    // payment_status_detail: transaction.payment_status_detail
  });
});


// --- Iniciar el Servidor ---
app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en puerto ${PORT}`);
  console.log(`URL Base (asegúrate que BACKEND_URL sea pública para webhooks): ${process.env.BACKEND_URL || 'URL NO DEFINIDA'}`);
  console.log("INFO: Este backend usa HTTP Polling y almacenamiento en memoria para estados.");
});
