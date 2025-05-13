// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3
const cors = require("cors");
const bodyParser = require("body-parser");
const { kv } = require("@vercel/kv");

// Inicialización de Express
const app = express();

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Puerto del servidor
const PORT = process.env.PORT || 3000;

// TTL para las entradas en KV (en segundos) - por ejemplo, 6 horas
const KV_TTL_SECONDS = 6 * 60 * 60;

// --- Validaciones de Variables de Entorno Críticas ---
if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    console.error("ERROR CRÍTICO: MERCADOPAGO_ACCESS_TOKEN no está definido. El servicio no funcionará.");
    // process.exit(1); // Descomentar para detener el servidor si falta
}
if (!process.env.BACKEND_URL) {
    console.error("ERROR CRÍTICO: BACKEND_URL no está definida. Las notificaciones de Mercado Pago (webhooks) fallarán.");
    // process.exit(1); // Descomentar para detener el servidor si falta
}
// FRONTEND_URL es necesaria si se usa auto_return con MercadoPago.
// Si no se usa un frontend web, se puede usar BACKEND_URL para las pantallas de feedback.
const FRONTEND_URL_BASE = process.env.FRONTEND_URL || process.env.BACKEND_URL;
if (!FRONTEND_URL_BASE) {
    console.warn(
        "ADVERTENCIA: Ni process.env.FRONTEND_URL ni process.env.BACKEND_URL están definidas." +
        "Las back_urls para Mercado Pago podrían ser inválidas si auto_return está activado, " +
        "lo que causaría errores en la creación de la preferencia." +
        "Se recomienda definir al menos BACKEND_URL para que las back_urls apunten a este mismo servidor."
    );
    // Si FRONTEND_URL_BASE sigue siendo nulo aquí, Mercado Pago podría rechazar la preferencia si auto_return="approved"
}


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
    res.send("Backend MercadoPago v3 para Vending (Vercel KV + External Ref) 🚀 - Pantallas de Feedback Incluidas");
});

app.post("/create-payment", async (req, res) => {
    console.log("Recibida petición /create-payment:", JSON.stringify(req.body, null, 2));
    try {
        const { machine_id, items, vending_transaction_id } = req.body;

        if (!machine_id || !items || !Array.isArray(items) || items.length === 0 || !vending_transaction_id) {
            console.warn("Petición /create-payment rechazada por datos faltantes: machine_id, items y/o vending_transaction_id.");
            return res.status(400).json({ error: "Faltan datos requeridos: machine_id, items válidos y vending_transaction_id." });
        }

        const constructedNotificationUrl = `${process.env.BACKEND_URL}/payment-webhook`;
        console.log(">>> URL DE NOTIFICACIÓN QUE SE ENVIARÁ A MERCADO PAGO:", constructedNotificationUrl);
        
        // --- Lógica de back_urls mejorada ---
        // Asegurarse de que FRONTEND_URL_BASE tenga un valor para construir las URLs de feedback.
        // Si FRONTEND_URL_BASE sigue siendo nulo aquí, es un problema de configuración grave.
        let success_url, failure_url, pending_url;

        if (FRONTEND_URL_BASE) {
            success_url = `${FRONTEND_URL_BASE}/payment-feedback?status=success&vending_txn_id=${vending_transaction_id}&mp_payment_id={payment_id}&mp_status={status}`;
            failure_url = `${FRONTEND_URL_BASE}/payment-feedback?status=failure&vending_txn_id=${vending_transaction_id}&mp_payment_id={payment_id}&mp_status={status}`;
            pending_url = `${FRONTEND_URL_BASE}/payment-feedback?status=pending&vending_txn_id=${vending_transaction_id}&mp_payment_id={payment_id}&mp_status={status}`;
        } else {
            // Fallback MUY básico si todo lo demás falla (esto NO debería pasar si BACKEND_URL está definida)
            // MP podría rechazar esto si no son URLs HTTPS válidas y públicas.
            // Idealmente, el servidor debería fallar al iniciar si no puede construir URLs válidas.
            console.error("ERROR CRÍTICO: No se pudo construir una base para back_urls. Usando placeholders relativos que probablemente fallarán con Mercado Pago.");
            const placeholderBase = "/payment-feedback"; // Esto es solo un intento desesperado
            success_url = `${placeholderBase}?status=success&vending_txn_id=${vending_transaction_id}`;
            failure_url = `${placeholderBase}?status=failure&vending_txn_id=${vending_transaction_id}`;
            pending_url = `${placeholderBase}?status=pending&vending_txn_id=${vending_transaction_id}`;
        }
        
        console.log(">>> URL de ÉXITO (back_url) que se enviará a MP:", success_url);

        const preferenceBody = {
            items: items.map(item => ({
                id: item.id || undefined,
                title: item.name ? item.name.substring(0, 250) : 'Producto',
                description: item.description || `Producto de ${machine_id}`,
                quantity: Number(item.quantity),
                currency_id: "MXN",
                unit_price: Number(item.price)
            })),
            external_reference: vending_transaction_id,
            notification_url: constructedNotificationUrl,
            back_urls: {
                success: success_url,
                failure: failure_url,
                pending: pending_url
            },
            auto_return: "approved"
        };

        console.log("Creando preferencia con datos (preferenceBody):", JSON.stringify(preferenceBody, null, 2));
        const preference = await preferenceClient.create({ body: preferenceBody });
        console.log("Preferencia creada exitosamente por MP. MP Preference ID:", preference.id, "External Reference (Vending Txn ID):", vending_transaction_id);

        const kvKey = `txn:${vending_transaction_id}`;
        const initialTxnData = {
            status: "pending",
            machine_id: machine_id,
            items: items,
            mp_preference_id: preference.id,
            mp_payment_id: null,
            payment_status_detail: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await kv.set(kvKey, initialTxnData, { ex: KV_TTL_SECONDS });
        console.log(`Estado inicial para Vending Txn ID ${vending_transaction_id} ("pending") guardado en KV.`);

        res.json({
            vending_transaction_id: vending_transaction_id,
            mp_preference_id: preference.id,
            init_point: preference.init_point,
            sandbox_init_point: preference.sandbox_init_point
        });

    } catch (error) {
        console.error("Error al crear preferencia de pago:", error); // Log completo del objeto error
        let errorDetails = "Error desconocido";
        if (error.cause && typeof error.cause === 'string') {
             try {
                const causeObj = JSON.parse(error.cause);
                errorDetails = causeObj.message || JSON.stringify(causeObj) ;
             } catch (e) {
                errorDetails = error.cause;
             }
        } else if (error.cause) {
            errorDetails = JSON.stringify(error.cause, null, 2);
        } else if (error.message) {
            errorDetails = error.message;
        }
        
        // Para errores del SDK de Mercado Pago, el error.cause puede ser un string JSON
        // que contiene un array de causas. Intentamos parsear el primero si existe.
        if (error.name === 'MercadoPagoError' && error.cause) {
            try {
                const causes = JSON.parse(error.cause);
                if (Array.isArray(causes) && causes.length > 0) {
                    errorDetails = causes[0].description || causes[0].message || JSON.stringify(causes[0]);
                }
            } catch (e) {
                // Si no se puede parsear, usamos el error.cause tal cual (ya lo hicimos arriba)
            }
        }
        
        console.error("Detalles del error para la respuesta:", errorDetails);
        res.status(500).json({ error: "No se pudo crear la preferencia de pago.", details: errorDetails });
    }
});

app.get("/payment-status", async (req, res) => {
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
        });
    } catch (error) {
        console.error(`Error al leer estado de KV para Vending Txn ID ${vendingTransactionId}:`, error);
        res.status(500).json({ error: "Error interno al consultar estado del pago." });
    }
    console.log(`--- [${new Date().toISOString()}] FIN GET /payment-status ---`);
});

app.post("/payment-webhook", async (req, res) => {
    console.log(`\n--- [${new Date().toISOString()}] INICIO Webhook /payment-webhook ---`);
    console.log("Headers del Webhook:", JSON.stringify(req.headers, null, 2));
    console.log("Cuerpo del Webhook (parseado):", JSON.stringify(req.body, null, 2));

    const notificationType = req.body.type || req.query.type;
    const paymentIdFromData = req.body.data?.id;
    const paymentIdFromQuery = req.query['data.id'] || req.query.id;
    let mpPaymentId = paymentIdFromData || paymentIdFromQuery;

    console.log(`Tipo de notificación recibida: ${notificationType}`);
    console.log(`MP Payment ID (desde data.id en body): ${paymentIdFromData}`);
    console.log(`MP Payment ID (desde query 'data.id' o 'id'): ${paymentIdFromQuery}`);
    console.log(`MP Payment ID a usar: ${mpPaymentId}`);

    if (notificationType !== 'payment' || !mpPaymentId) {
        console.log("Notificación ignorada (no es de tipo 'payment' o falta MP Payment ID).");
        console.log(`--- [${new Date().toISOString()}] FIN Webhook (Ignorado/ID no encontrado) ---`);
        return res.sendStatus(200);
    }

    try {
        console.log(`[TRY] Procesando notificación para MP Payment ID: ${mpPaymentId}`);
        const payment = await paymentClient.get({ id: mpPaymentId });
        console.log(`[TRY] Llamada a paymentClient.get para MP Payment ID ${mpPaymentId} completada.`);

        if (!payment) {
            console.error(`[TRY] No se encontraron detalles en MP para el MP Payment ID: ${mpPaymentId}.`);
            return res.sendStatus(200);
        }

        const vendingTransactionId = payment.external_reference;
        const paymentStatus = payment.status;
        const mpPreferenceIdFromPayment = payment.preference_id;

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
            currentTxnData.mp_payment_id = payment.id;
            currentTxnData.payment_status_detail = payment.status_detail;
            currentTxnData.updatedAt = new Date().toISOString();
            
            if (mpPreferenceIdFromPayment && currentTxnData.mp_preference_id !== mpPreferenceIdFromPayment) {
                console.warn(`Webhook: MP Preference ID del pago (${mpPreferenceIdFromPayment}) difiere del guardado originalmente (${currentTxnData.mp_preference_id}) para Vending Txn ID ${vendingTransactionId}`);
            }
            currentTxnData.mp_reported_preference_id_on_payment = mpPreferenceIdFromPayment;

            await kv.set(kvKey, currentTxnData, { ex: KV_TTL_SECONDS });
            console.log(`Estado para Vending Txn ID ${vendingTransactionId} actualizado a '${paymentStatus}' en KV.`);
        } else {
            console.warn(`Webhook: No se encontró estado inicial en KV para Vending Txn ID: ${vendingTransactionId}. Creando nueva entrada si el pago está aprobado/finalizado.`);
            if (['approved', 'rejected', 'cancelled', 'refunded'].includes(paymentStatus)) {
                const newTxnData = {
                    status: paymentStatus,
                    machine_id: payment.metadata?.machine_id || null, 
                    items: payment.additional_info?.items || [],
                    mp_preference_id: mpPreferenceIdFromPayment,
                    mp_payment_id: payment.id,
                    payment_status_detail: payment.status_detail,
                    createdAt: payment.date_created || new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    external_reference_from_payment: vendingTransactionId
                };
                if (payment.metadata && payment.metadata.machine_id) { // Para que esto funcione, machine_id debe enviarse en metadata al crear preferencia
                    newTxnData.machine_id = payment.metadata.machine_id;
                }
                await kv.set(kvKey, newTxnData, { ex: KV_TTL_SECONDS });
                console.log(`Nueva entrada creada en KV para Vending Txn ID ${vendingTransactionId} con estado '${paymentStatus}'.`);
            }
        }

        if (paymentStatus === 'approved') {
            console.log(`[INFO] PAGO APROBADO para MP Payment ID ${mpPaymentId} (Vending Txn ID: ${vendingTransactionId}). Machine: ${currentTxnData?.machine_id || payment.metadata?.machine_id || 'No disponible'}.`);
            console.log(`[INFO] 🚀 Aquí iría la lógica para notificar a la máquina que dispense el producto.`);
        } else {
            console.log(`[INFO] Estado del pago ${mpPaymentId} (Vending Txn ID: ${vendingTransactionId}) es '${paymentStatus}'.`);
        }

        res.sendStatus(200);

    } catch (error) {
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("!!!!!!!!    Error en CATCH procesando webhook      !!!!!!!!!");
        if (error.cause) {
            console.error("Error Cause (SDK Mercado Pago u otro):", JSON.stringify(error.cause, null, 2));
        } else {
            console.error("Error Object (General):", error);
        }
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        res.sendStatus(200);
    }
    console.log(`--- [${new Date().toISOString()}] FIN Webhook /payment-webhook ---`);
});

// --- NUEVO: Endpoints para las "Pantallas" de Feedback de Mercado Pago ---
app.get("/payment-feedback", (req, res) => {
    const status = req.query.status;
    const vendingTxnId = req.query.vending_txn_id;
    const mpPaymentId = req.query.payment_id || req.query.mp_payment_id; // MP usa payment_id en la redirección
    const mpStatus = req.query.status || req.query.mp_status; // MP usa status en la redirección
    // Otros parámetros que MP podría enviar: collection_id, collection_status, preference_id, site_id, processing_mode, merchant_account_id, external_reference

    console.log(`\n--- [${new Date().toISOString()}] INICIO GET /payment-feedback ---`);
    console.log("Query Params recibidos en /payment-feedback:", JSON.stringify(req.query, null, 2));

    let title = "Estado del Pago";
    let message = `El estado de tu pago para la transacción ${vendingTxnId || 'desconocida'} es: ${status || 'desconocido'}.`;
    let bgColor = "#eee";
    let textColor = "#333";

    switch (status) {
        case "success":
            title = "¡Pago Aprobado!";
            message = `Tu pago (ID MP: ${mpPaymentId || 'N/A'}) para la transacción ${vendingTxnId} fue aprobado. Estado MP: ${mpStatus}.`;
            bgColor = "#d4edda"; // Verde claro
            textColor = "#155724";
            break;
        case "failure":
            title = "Pago Rechazado";
            message = `Tu pago (ID MP: ${mpPaymentId || 'N/A'}) para la transacción ${vendingTxnId} fue rechazado. Estado MP: ${mpStatus}. Por favor, intenta nuevamente o usa otro método de pago.`;
            bgColor = "#f8d7da"; // Rojo claro
            textColor = "#721c24";
            break;
        case "pending":
            title = "Pago Pendiente";
            message = `Tu pago (ID MP: ${mpPaymentId || 'N/A'}) para la transacción ${vendingTxnId} está pendiente de procesamiento. Estado MP: ${mpStatus}. Te notificaremos cuando cambie el estado.`;
            bgColor = "#fff3cd"; // Amarillo claro
            textColor = "#856404";
            break;
        default:
            title = "Información de Pago";
            message = `Información recibida para la transacción ${vendingTxnId}. Estado: ${status}, ID de Pago MP: ${mpPaymentId}.`;
    }

    // Enviar una respuesta HTML simple.
    // Para una app Android que hace polling, esta pantalla es más para cumplir con MP si `auto_return` se usa.
    // La app Android normalmente no verá esto directamente.
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-F">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title} - Vending Machine</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 0; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 90vh; text-align: center; background-color: #f0f0f0; }
                .container { background-color: ${bgColor}; color: ${textColor}; padding: 30px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); max-width: 600px; }
                h1 { margin-top: 0; }
                p { line-height: 1.6; }
                .footer { margin-top: 20px; font-size: 0.9em; color: #777; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>${title}</h1>
                <p>${message}</p>
                <p class="footer">Puedes cerrar esta ventana.</p>
            </div>
        </body>
        </html>
    `);
    console.log(`--- [${new Date().toISOString()}] FIN GET /payment-feedback (Estado: ${status}) ---`);
});


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
    if (process.env.BACKEND_URL) { // BACKEND_URL es crítico
        console.log(`URL Base (asegúrate que sea pública para webhooks y back_urls si FRONTEND_URL no está seteada): ${process.env.BACKEND_URL}`);
    }
    // No es necesario volver a loguear las variables de entorno aquí si ya se hizo arriba.
    console.log(`INFO: Este backend está configurado para MODO ${process.env.NODE_ENV === "development" ? 'Sandbox' : 'Producción'}.`);
    console.log("INFO: Usando Vercel KV para almacenamiento de estados de pago (HTTP Polling).");
});
