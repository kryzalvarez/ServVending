// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3
const cors = require("cors");
const bodyParser = require("body-parser");
const { kv } = require("@vercel/kv"); // ¡NUEVO! Importar Vercel KV

// Inicialización de Express
const app = express();

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Puerto del servidor
const PORT = process.env.PORT || 3000;

// TTL para las entradas en KV (en segundos) - por ejemplo, 6 horas
const KV_TTL_SECONDS = 6 * 60 * 60;

// 1. Configuración de MercadoPago (Usando SDK v3)
const client = new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
    options: { timeout: 5000, sandbox: process.env.NODE_ENV === "development" }
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

console.log(`Mercado Pago SDK inicializado en modo ${process.env.NODE_ENV === "development" ? 'Sandbox' : 'Producción'}`);
console.log("INFO: Usando Vercel KV para almacenamiento de estados de pago.");

// --- 3. Endpoints de la API ---

app.get("/", (req, res) => {
    res.send("Backend MercadoPago v3 para Vending (Vercel KV + External Ref) 🚀");
});

app.post("/create-payment", async (req, res) => {
    console.log("Recibida petición /create-payment:", JSON.stringify(req.body, null, 2));
    try {
        // ¡NUEVO! Esperar vending_transaction_id y machine_id
        const { machine_id, items, vending_transaction_id } = req.body;

        if (!machine_id || !items || !Array.isArray(items) || items.length === 0 || !vending_transaction_id) {
            console.warn("Petición /create-payment rechazada por datos faltantes: machine_id, items y/o vending_transaction_id.");
            return res.status(400).json({ error: "Faltan datos requeridos: machine_id, items válidos y vending_transaction_id." });
        }

        const constructedNotificationUrl = `${process.env.BACKEND_URL}/payment-webhook`;
        console.log(">>> URL DE NOTIFICACIÓN QUE SE ENVIARÁ A MERCADO PAGO:", constructedNotificationUrl);
        if (!process.env.BACKEND_URL) {
            console.error("ALERTA: process.env.BACKEND_URL no está definida. La notification_url será inválida.");
        }

        const preferenceBody = {
            items: items.map(item => ({
                id: item.id || undefined, // El ID del item en tu sistema, si lo tienes
                title: item.name ? item.name.substring(0, 250) : 'Producto',
                description: item.description || `Producto de ${machine_id}`,
                quantity: Number(item.quantity),
                currency_id: "MXN", // O la moneda que uses
                unit_price: Number(item.price)
            })),
            external_reference: vending_transaction_id, // ¡NUEVO! Usar vending_transaction_id
            notification_url: constructedNotificationUrl,
            back_urls: { // Opcional: URLs a las que el usuario es redirigido
                success: `${process.env.FRONTEND_URL || req.protocol + '://' + req.get('host')}/payment-feedback?status=success&vending_txn_id=${vending_transaction_id}`,
                failure: `${process.env.FRONTEND_URL || req.protocol + '://' + req.get('host')}/payment-feedback?status=failure&vending_txn_id=${vending_transaction_id}`,
                pending: `${process.env.FRONTEND_URL || req.protocol + '://' + req.get('host')}/payment-feedback?status=pending&vending_txn_id=${vending_transaction_id}`
            },
            auto_return: "approved" // Opcional: Redirigir automáticamente si el pago es aprobado
        };

        console.log("Creando preferencia con datos (preferenceBody):", JSON.stringify(preferenceBody, null, 2));
        const preference = await preferenceClient.create({ body: preferenceBody });
        console.log("Preferencia creada exitosamente por MP. MP Preference ID:", preference.id, "External Reference (Vending Txn ID):", vending_transaction_id);

        // ¡NUEVO! Guardar estado inicial en Vercel KV
        const kvKey = `txn:${vending_transaction_id}`;
        const initialTxnData = {
            status: "pending",
            machine_id: machine_id,
            items: items,
            mp_preference_id: preference.id, // Guardamos el ID de preferencia de MP
            mp_payment_id: null, // Aún no hay ID de pago
            payment_status_detail: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await kv.set(kvKey, initialTxnData, { ex: KV_TTL_SECONDS });
        console.log(`Estado inicial para Vending Txn ID ${vending_transaction_id} ("pending") guardado en KV.`);

        res.json({
            vending_transaction_id: vending_transaction_id, // Devolver el ID que la app usará para sondear
            mp_preference_id: preference.id, // El ID de la preferencia de Mercado Pago
            init_point: preference.init_point,
            sandbox_init_point: preference.sandbox_init_point // Útil si estás probando en sandbox
        });

    } catch (error) {
        console.error("Error al crear preferencia de pago:", error.cause || error.message || error);
        const errorDetails = error.cause ? JSON.stringify(error.cause, null, 2) : error.message;
        res.status(500).json({ error: "No se pudo crear la preferencia de pago.", details: errorDetails });
    }
});

// --- ENDPOINT GET /payment-status PARA POLLING (MODIFICADO) ---
app.get("/payment-status", async (req, res) => { // Marcar como async
    // ¡NUEVO! Usar vending_transaction_id
    const vendingTransactionId = req.query.vending_transaction_id;

    if (!vendingTransactionId) {
        return res.status(400).json({ error: "Falta el parámetro 'vending_transaction_id'." });
    }
    console.log(`\n--- [${new Date().toISOString()}] INICIO GET /payment-status ---`);
    console.log(`Solicitud de estado (polling) para Vending Txn ID: ${vendingTransactionId}`);

    try {
        const kvKey = `txn:${vendingTransactionId}`;
        const transactionData = await kv.get(kvKey);

        if (!transactionData) {
            console.log(`Estado para Vending Txn ID ${vendingTransactionId} NO encontrado en KV. Devolviendo not_found.`);
            return res.status(404).json({
                vending_transaction_id: vendingTransactionId,
                status: "not_found",
                message: "Transacción no encontrada. Puede que aún no se haya creado, el ID sea incorrecto o haya expirado."
            });
        }

        console.log(`Devolviendo estado para Vending Txn ID ${vendingTransactionId}: ${transactionData.status}`);
        res.json({
            vending_transaction_id: vendingTransactionId,
            status: transactionData.status,
            machine_id: transactionData.machine_id,
            // Puedes añadir más detalles si la app los necesita y están en transactionData
            // items: transactionData.items,
            // payment_status_detail: transactionData.payment_status_detail
        });
    } catch (error) {
        console.error(`Error al leer estado de KV para Vending Txn ID ${vendingTransactionId}:`, error);
        res.status(500).json({ error: "Error interno al consultar estado del pago." });
    }
    console.log(`--- [${new Date().toISOString()}] FIN GET /payment-status ---`);
});

// --- WEBHOOK PRINCIPAL (MODIFICADO) ---
app.post("/payment-webhook", async (req, res) => { // Marcar como async
    console.log(`\n--- [${new Date().toISOString()}] INICIO Webhook /payment-webhook ---`);
    console.log("Headers del Webhook:", JSON.stringify(req.headers, null, 2));
    console.log("Cuerpo del Webhook (parseado):", JSON.stringify(req.body, null, 2));

    const notificationType = req.body.type || req.query.type;
    const paymentIdFromData = req.body.data?.id; // Este es el MP Payment ID
    const paymentIdFromQuery = req.query['data.id'] || req.query.id;
    let mpPaymentId = paymentIdFromData || paymentIdFromQuery;

    console.log(`Tipo de notificación recibida: ${notificationType}`);
    console.log(`MP Payment ID (desde data.id en body): ${paymentIdFromData}`);
    console.log(`MP Payment ID (desde query 'data.id' o 'id'): ${paymentIdFromQuery}`);
    console.log(`MP Payment ID a usar: ${mpPaymentId}`);

    if (notificationType !== 'payment' || !mpPaymentId) {
        console.log("Notificación ignorada (no es de tipo 'payment' o falta MP Payment ID).");
        console.log(`--- [${new Date().toISOString()}] FIN Webhook (Ignorado/ID no encontrado) ---`);
        return res.sendStatus(200); // Responder 200 OK a MP para que no reintente
    }

    try {
        console.log(`[TRY] Procesando notificación para MP Payment ID: ${mpPaymentId}`);
        const payment = await paymentClient.get({ id: mpPaymentId });
        console.log(`[TRY] Llamada a paymentClient.get para MP Payment ID ${mpPaymentId} completada.`);

        if (!payment) {
            console.error(`[TRY] No se encontraron detalles en MP para el MP Payment ID: ${mpPaymentId}.`);
            return res.sendStatus(200);
        }

        // ¡NUEVO! Usar external_reference como vending_transaction_id
        const vendingTransactionId = payment.external_reference;
        const paymentStatus = payment.status; // ej. "approved", "rejected"
        const mpPreferenceIdFromPayment = payment.preference_id; // El ID de preferencia asociado a este pago

        console.log("----------------------------------------------------");
        console.log("--- DETALLES DEL PAGO OBTENIDOS DE MERCADO PAGO ---");
        console.log(`  MP Payment ID: ${payment.id}`);
        console.log(`  Status: ${paymentStatus}`);
        console.log(`  Status Detail: ${payment.status_detail}`);
        console.log(`  MP Preference ID (del pago): ${mpPreferenceIdFromPayment || 'No encontrado'}`);
        console.log(`  External Reference (Vending Txn ID): ${vendingTransactionId}`);
        console.log("----------------------------------------------------");

        if (!vendingTransactionId) {
            console.error(`[TRY] ERROR CRÍTICO: No se encontró external_reference (Vending Txn ID) en el pago ${mpPaymentId}. No se puede actualizar estado en KV.`);
            return res.sendStatus(200);
        }

        const kvKey = `txn:${vendingTransactionId}`;
        const currentTxnData = await kv.get(kvKey);

        if (currentTxnData) {
            currentTxnData.status = paymentStatus;
            currentTxnData.mp_payment_id = payment.id; // Guardar el ID del pago de MP
            currentTxnData.payment_status_detail = payment.status_detail;
            currentTxnData.updatedAt = new Date().toISOString();
            
            // Log si el preference_id del pago difiere del que se guardó al crear la preferencia
            if (mpPreferenceIdFromPayment && currentTxnData.mp_preference_id !== mpPreferenceIdFromPayment) {
                console.warn(`Webhook: MP Preference ID del pago (${mpPreferenceIdFromPayment}) difiere del guardado originalmente (${currentTxnData.mp_preference_id}) para Vending Txn ID ${vendingTransactionId}`);
            }
            currentTxnData.mp_reported_preference_id_on_payment = mpPreferenceIdFromPayment;


            await kv.set(kvKey, currentTxnData, { ex: KV_TTL_SECONDS }); // Actualizar con TTL
            console.log(`Estado para Vending Txn ID ${vendingTransactionId} actualizado a '${paymentStatus}' en KV.`);
        } else {
            // Esto podría pasar si el webhook llega antes de que /create-payment termine de escribir en KV,
            // o si la entrada expiró, o si hubo un error en /create-payment al guardar en KV.
            // O si el vending_transaction_id no coincide por alguna razón.
            console.warn(`Webhook: No se encontró estado inicial en KV para Vending Txn ID: ${vendingTransactionId}. Creando nueva entrada si el pago está aprobado/finalizado.`);
            // Crear una entrada si el estado es relevante (aprobado, rechazado, etc.)
            if (['approved', 'rejected', 'cancelled', 'refunded'].includes(paymentStatus)) {
                const newTxnData = {
                    status: paymentStatus,
                    machine_id: null, // No podemos saberlo si no estaba la entrada original, o intentar obtenerlo de metadata si MP lo permite
                    items: payment.additional_info?.items || [],
                    mp_preference_id: mpPreferenceIdFromPayment,
                    mp_payment_id: payment.id,
                    payment_status_detail: payment.status_detail,
                    createdAt: payment.date_created || new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    external_reference_from_payment: vendingTransactionId // Para confirmar
                };
                // Tratar de obtener machine_id de payment.metadata si lo hubieras configurado allí
                if (payment.metadata && payment.metadata.machine_id) {
                    newTxnData.machine_id = payment.metadata.machine_id;
                }
                await kv.set(kvKey, newTxnData, { ex: KV_TTL_SECONDS });
                console.log(`Nueva entrada creada en KV para Vending Txn ID ${vendingTransactionId} con estado '${paymentStatus}'.`);
            }
        }

        if (paymentStatus === 'approved') {
            console.log(`[INFO] PAGO APROBADO para MP Payment ID ${mpPaymentId} (Vending Txn ID: ${vendingTransactionId}). Machine: ${currentTxnData?.machine_id || 'No disponible en entrada KV'}.`);
            console.log(`[INFO] 🚀 Aquí iría la lógica para notificar a la máquina que dispense el producto (si es necesario desde el backend).`);
        } else {
            console.log(`[INFO] Estado del pago ${mpPaymentId} (Vending Txn ID: ${vendingTransactionId}) es '${paymentStatus}'.`);
        }

        res.sendStatus(200); // Siempre responder 200 OK a Mercado Pago

    } catch (error) {
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("!!!!!!!!    Error en CATCH procesando webhook     !!!!!!!!!");
        if (error.cause) { // Error del SDK de Mercado Pago
            console.error("Error Cause (SDK Mercado Pago):", JSON.stringify(error.cause, null, 2));
        } else { // Otro tipo de error
            console.error("Error Object (General):", error);
        }
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        // No enviar error 500 a Mercado Pago a menos que sea estrictamente necesario,
        // ya que podrían deshabilitar el webhook. Es mejor loguear y responder 200.
        // Si el error es por ejemplo con KV, MP no necesita saberlo.
        res.sendStatus(200); // Aún así responder 200 a MP para evitar reintentos excesivos.
    }
    console.log(`--- [${new Date().toISOString()}] FIN Webhook /payment-webhook ---`);
});


// --- Endpoint de prueba simple para webhooks (puedes mantenerlo para debugging) ---
app.post("/test-webhook", (req, res) => {
    console.log(`\n--- [${new Date().toISOString()}] INICIO Webhook /test-webhook ---`);
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    console.log("Cuerpo:", JSON.stringify(req.body, null, 2));
    console.log("Query:", JSON.stringify(req.query, null, 2));
    res.status(200).json({ message: "Test webhook received", body: req.body, query: req.query });
    console.log(`--- [${new Date().toISOString()}] FIN Webhook /test-webhook ---`);
});

// --- Iniciar el Servidor ---
app.listen(PORT, () => {
    console.log(`Servidor Express escuchando en puerto ${PORT}`);
    console.log(`URL Base (asegúrate que BACKEND_URL sea pública para webhooks): ${process.env.BACKEND_URL || 'URL NO DEFINIDA -> ¡WEBHOOKS FALLARÁN!'}`);
    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) console.error("ALERTA: MERCADOPAGO_ACCESS_TOKEN no está definido.");
    if (!process.env.FRONTEND_URL) console.warn("ADVERTENCIA: FRONTEND_URL no está definido (back_urls podrían fallar).");
    console.log(`INFO: Este backend está configurado para MODO ${process.env.NODE_ENV === "development" ? 'Sandbox' : 'Producción'}.`);
    console.log("INFO: Usando Vercel KV para almacenamiento de estados de pago (HTTP Polling).");
});
