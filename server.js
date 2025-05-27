// Carga variables de entorno desde .env (asegúrate de tener este archivo)
require("dotenv").config();

// Importaciones de módulos
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago"); // SDK v3
const cors = require("cors");
const bodyParser = require("body-parser");
const { kv } = require("@vercel/kv");

// <<< --- INICIO IMPORTACIONES PARA HTTPS Y WEBSOCKETS SEGUROS (WSS) --- >>>
const https = require('https');   // Para el servidor HTTPS
const fs = require('fs');        // Para leer archivos de certificado SSL (si los gestionas tú mismo)
const WebSocket = require('ws'); // Para el servidor WebSocket
// <<< --- FIN IMPORTACIONES PARA HTTPS Y WEBSOCKETS SEGUROS (WSS) --- >>>

// Inicialización de Express (esta instancia 'app' se usará para HTTPS/API y como base para WSS)
const app = express();

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// <<< --- PUERTO PARA HTTPS Y WSS --- >>>
// Ambos, HTTPS y WSS, usarán este mismo puerto.
// En producción, usualmente es 443, pero process.env.PORT es común para PaaS.
const PORT = process.env.PORT || 3000;
// <<< --- FIN PUERTO --- >>>

// TTL para las entradas en KV (en segundos) - por ejemplo, 6 horas
const KV_TTL_SECONDS = 6 * 60 * 60;

// --- Validaciones de Variables de Entorno Críticas ---
if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    console.error("ERROR CRÍTICO: MERCADOPAGO_ACCESS_TOKEN no está definido. El servicio no funcionará.");
    // process.exit(1); // Considera detener si es crítico
}
// BACKEND_URL DEBE apuntar a tu URL HTTPS pública
if (!process.env.BACKEND_URL || !process.env.BACKEND_URL.startsWith("https://")) {
    console.error("ERROR CRÍTICO: BACKEND_URL no está definida o no es HTTPS. Las notificaciones de Mercado Pago (webhooks) y WSS podrían fallar o ser inseguras.");
    // process.exit(1);
}
const FRONTEND_URL_BASE = process.env.FRONTEND_URL || process.env.BACKEND_URL;
if (!FRONTEND_URL_BASE) {
    console.warn(
        "ADVERTENCIA: Ni process.env.FRONTEND_URL ni process.env.BACKEND_URL están definidas." +
        "Las back_urls para Mercado Pago podrían ser inválidas..." // Mensaje abreviado
    );
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


// <<< --- INICIO ALMACENAMIENTO PARA CONEXIONES WEBSOCKET (WSS) ACTIVAS --- >>>
// Este Map guardará la conexión WebSocket para cada machine_id conectado vía wss://
const activeMachinesWSS = new Map(); // Clave: machine_id, Valor: objeto WebSocket
// <<< --- FIN ALMACENAMIENTO PARA CONEXIONES WEBSOCKET (WSS) ACTIVAS --- >>>


// --- 3. Endpoints de la API (Servidos por 'app' sobre HTTPS) ---

app.get("/", (req, res) => {
    res.send("Backend Vending: API (HTTPS) 🚀 | Notificaciones (WSS) 🔒 - Pantallas de Feedback Incluidas");
});

app.post("/create-payment", async (req, res) => {
    console.log("(HTTPS) Recibida petición /create-payment:", JSON.stringify(req.body, null, 2));
    try {
        const { machine_id, items, vending_transaction_id } = req.body;

        if (!machine_id || !items || !Array.isArray(items) || items.length === 0 || !vending_transaction_id) {
            console.warn("(HTTPS) Petición /create-payment rechazada por datos faltantes.");
            return res.status(400).json({ error: "Faltan datos requeridos: machine_id, items válidos y vending_transaction_id." });
        }

        const constructedNotificationUrl = `${process.env.BACKEND_URL}/payment-webhook`; // BACKEND_URL debe ser HTTPS
        console.log("(HTTPS) >>> URL DE NOTIFICACIÓN (HTTPS) A MERCADO PAGO:", constructedNotificationUrl);
        
        let success_url, failure_url, pending_url;
        if (FRONTEND_URL_BASE) { // FRONTEND_URL_BASE también debería ser HTTPS
            success_url = `${FRONTEND_URL_BASE}/payment-feedback?status=success&vending_txn_id=${vending_transaction_id}&mp_payment_id={payment_id}&mp_status={status}`;
            failure_url = `${FRONTEND_URL_BASE}/payment-feedback?status=failure&vending_txn_id=${vending_transaction_id}&mp_payment_id={payment_id}&mp_status={status}`;
            pending_url = `${FRONTEND_URL_BASE}/payment-feedback?status=pending&vending_txn_id=${vending_transaction_id}&mp_payment_id={payment_id}&mp_status={status}`;
        } else {
            console.error("(HTTPS) ERROR CRÍTICO: No se pudo construir una base para back_urls.");
            const placeholderBase = "/payment-feedback"; // Esto es un fallback problemático
            success_url = `${placeholderBase}?status=success&vending_txn_id=${vending_transaction_id}`;
            failure_url = `${placeholderBase}?status=failure&vending_txn_id=${vending_transaction_id}`;
            pending_url = `${placeholderBase}?status=pending&vending_txn_id=${vending_transaction_id}`;
        }
        console.log("(HTTPS) >>> URL de ÉXITO (back_url) que se enviará a MP:", success_url);

        const preferenceBody = {
            items: items.map(item => ({
                id: item.id || undefined,
                title: item.name ? item.name.substring(0, 250) : 'Producto',
                description: item.description || `Producto de ${machine_id}`,
                quantity: Number(item.quantity),
                currency_id: "MXN", // Ajusta tu moneda
                unit_price: Number(item.price)
            })),
            external_reference: vending_transaction_id,
            notification_url: constructedNotificationUrl, // Debe ser HTTPS
            back_urls: { // Deben ser HTTPS
                success: success_url,
                failure: failure_url,
                pending: pending_url
            },
            auto_return: "approved"
        };

        console.log("(HTTPS) Creando preferencia con datos (preferenceBody):", JSON.stringify(preferenceBody, null, 2));
        const preference = await preferenceClient.create({ body: preferenceBody });
        console.log("(HTTPS) Preferencia creada. MP Preference ID:", preference.id, "Vending Txn ID:", vending_transaction_id);

        const kvKey = `txn:${vending_transaction_id}`;
        const initialTxnData = {
            status: "pending",
            machine_id: machine_id, // IMPORTANTE: machine_id se guarda para la notificación WSS
            items: items,
            mp_preference_id: preference.id,
            mp_payment_id: null,
            payment_status_detail: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await kv.set(kvKey, initialTxnData, { ex: KV_TTL_SECONDS });
        console.log(`(HTTPS) Estado inicial para ${vending_transaction_id} ("pending") guardado en KV.`);

        res.json({
            vending_transaction_id: vending_transaction_id,
            mp_preference_id: preference.id,
            init_point: preference.init_point,
            sandbox_init_point: preference.sandbox_init_point
        });

    } catch (error) {
        console.error("(HTTPS) Error al crear preferencia de pago:", error);
        let errorDetails = "Error desconocido";
        if (error.cause && typeof error.cause === 'string') { try { const causeObj = JSON.parse(error.cause); errorDetails = causeObj.message || JSON.stringify(causeObj); } catch (e) { errorDetails = error.cause; }}
        else if (error.cause) { errorDetails = JSON.stringify(error.cause, null, 2); }
        else if (error.message) { errorDetails = error.message; }
        if (error.name === 'MercadoPagoError' && error.cause) { try { const causes = JSON.parse(error.cause); if (Array.isArray(causes) && causes.length > 0) { errorDetails = causes[0].description || causes[0].message || JSON.stringify(causes[0]); }} catch (e) { /*no-op*/ }}
        console.error("(HTTPS) Detalles del error para la respuesta:", errorDetails);
        res.status(500).json({ error: "No se pudo crear la preferencia de pago.", details: errorDetails });
    }
});

app.get("/payment-status", async (req, res) => {
    const vendingTransactionId = req.query.vending_transaction_id;
    if (!vendingTransactionId) {
        return res.status(400).json({ error: "Falta el parámetro 'vending_transaction_id'." });
    }
    console.log(`\n--- (HTTPS) [${new Date().toISOString()}] INICIO GET /payment-status ---`);
    console.log(`(HTTPS) Polling para Vending Txn ID: ${vendingTransactionId}`);
    try {
        const kvKey = `txn:${vendingTransactionId}`;
        const transactionData = await kv.get(kvKey);
        if (!transactionData) {
            console.log(`(HTTPS) Estado para ${vendingTransactionId} NO encontrado en KV.`);
            return res.status(404).json({ vending_transaction_id: vendingTransactionId, status: "not_found", message: "Transacción no encontrada..."});
        }
        console.log(`(HTTPS) Devolviendo estado para ${vendingTransactionId}: ${transactionData.status}`);
        res.json({ vending_transaction_id: vendingTransactionId, status: transactionData.status, machine_id: transactionData.machine_id });
    } catch (error) {
        console.error(`(HTTPS) Error al leer estado de KV para ${vendingTransactionId}:`, error);
        res.status(500).json({ error: "Error interno al consultar estado del pago." });
    }
    console.log(`--- (HTTPS) [${new Date().toISOString()}] FIN GET /payment-status ---`);
});

// Webhook de MercadoPago (recibido por el servidor HTTPS)
app.post("/payment-webhook", async (req, res) => {
    console.log(`\n--- (HTTPS) [${new Date().toISOString()}] INICIO Webhook /payment-webhook ---`);
    console.log("(HTTPS) Headers del Webhook:", JSON.stringify(req.headers, null, 2));
    console.log("(HTTPS) Cuerpo del Webhook:", JSON.stringify(req.body, null, 2));

    const notificationType = req.body.type || req.query.type;
    const paymentIdFromData = req.body.data?.id;
    const paymentIdFromQuery = req.query['data.id'] || req.query.id;
    let mpPaymentId = paymentIdFromData || paymentIdFromQuery;

    console.log(`(HTTPS) Tipo de notificación: ${notificationType}, MP Payment ID: ${mpPaymentId}`);

    if (notificationType !== 'payment' || !mpPaymentId) {
        console.log("(HTTPS) Notificación ignorada.");
        return res.sendStatus(200);
    }

    try {
        console.log(`(HTTPS) Procesando notificación para MP Payment ID: ${mpPaymentId}`);
        const payment = await paymentClient.get({ id: mpPaymentId });
        if (!payment) {
            console.error(`(HTTPS) No se encontraron detalles en MP para MP Payment ID: ${mpPaymentId}.`);
            return res.sendStatus(200);
        }

        const vendingTransactionId = payment.external_reference;
        const paymentStatus = payment.status;
        // ... (tus logs de detalles del pago originales) ...
        console.log("----------------------------------------------------");
        console.log("--- DETALLES DEL PAGO OBTENIDOS DE MERCADO PAGO (HTTPS) ---");
        console.log(`  MP Payment ID: ${payment.id}, Status: ${paymentStatus}`);
        console.log(`  Vending Txn ID: ${vendingTransactionId}`);
        console.log("----------------------------------------------------");


        if (!vendingTransactionId) {
            console.error(`(HTTPS) ERROR CRÍTICO: Falta external_reference (Vending Txn ID) en pago ${mpPaymentId}.`);
            return res.sendStatus(200);
        }

        const kvKey = `txn:${vendingTransactionId}`;
        let currentTxnData = await kv.get(kvKey); // Renombrado para claridad

        if (currentTxnData) {
            currentTxnData.status = paymentStatus;
            currentTxnData.mp_payment_id = payment.id;
            currentTxnData.payment_status_detail = payment.status_detail;
            currentTxnData.updatedAt = new Date().toISOString();
            // ... (tu lógica de advertencia de preference_id) ...
            await kv.set(kvKey, currentTxnData, { ex: KV_TTL_SECONDS });
            console.log(`(HTTPS) Estado para ${vendingTransactionId} actualizado a '${paymentStatus}' en KV.`);
        } else {
            console.warn(`(HTTPS) Webhook: No se encontró estado inicial en KV para ${vendingTransactionId}. Creando nueva entrada si es estado final.`);
            // ... (tu lógica para crear nueva entrada en KV si no existe y el estado es final) ...
            if (['approved', 'rejected', 'cancelled', 'refunded'].includes(paymentStatus)) {
                const newTxnData = { /* ... tu objeto newTxnData ... */
                    status: paymentStatus, machine_id: payment.metadata?.machine_id || null, items: payment.additional_info?.items || [],
                    mp_preference_id: payment.preference_id, mp_payment_id: payment.id, payment_status_detail: payment.status_detail,
                    createdAt: payment.date_created || new Date().toISOString(), updatedAt: new Date().toISOString(),
                    external_reference_from_payment: vendingTransactionId
                };
                if (payment.metadata && payment.metadata.machine_id) { newTxnData.machine_id = payment.metadata.machine_id; }
                await kv.set(kvKey, newTxnData, { ex: KV_TTL_SECONDS });
                currentTxnData = newTxnData; // Asignar para la lógica WSS de abajo
                console.log(`(HTTPS) Nueva entrada creada en KV para ${vendingTransactionId} con estado '${paymentStatus}'.`);
            }
        }

        // <<< --- INICIO LÓGICA DE NOTIFICACIÓN WEBSOCKET SEGURO (WSS) --- >>>
        if (paymentStatus === 'approved' && currentTxnData && currentTxnData.machine_id) {
            const targetMachineId = currentTxnData.machine_id;
            console.log(`(HTTPS /payment-webhook) PAGO APROBADO. Intentando notificar a ${targetMachineId} vía WSS.`);

            const wssConnection = activeMachinesWSS.get(targetMachineId);
            if (wssConnection && wssConnection.readyState === WebSocket.OPEN) {
                const notificationPayload = {
                    type: "payment_approved", // Un tipo de mensaje que tu app Android entenderá
                    vending_transaction_id: vendingTransactionId,
                    status: paymentStatus, // "approved"
                };
                try {
                    wssConnection.send(JSON.stringify(notificationPayload));
                    console.log(`(HTTPS /payment-webhook) Notificación WSS enviada a ${targetMachineId} para Txn ${vendingTransactionId}.`);
                } catch (sendError) {
                    console.error(`(HTTPS /payment-webhook) Error enviando mensaje WSS a ${targetMachineId}:`, sendError);
                }
            } else {
                console.warn(`(HTTPS /payment-webhook) No se encontró conexión WSS activa/abierta para ${targetMachineId}. La máquina usará polling.`);
            }
        } else if (currentTxnData) {
             console.log(`(HTTPS /payment-webhook) Estado del pago para ${vendingTransactionId} es '${paymentStatus}'. Machine: ${currentTxnData.machine_id || 'N/A'}. No se envía notificación WSS.`);
        } else {
             console.warn(`(HTTPS /payment-webhook) currentTxnData es nulo para ${vendingTransactionId}. No se puede enviar notificación WSS.`);
        }
        // <<< --- FIN LÓGICA DE NOTIFICACIÓN WEBSOCKET SEGURO (WSS) --- >>>

        res.sendStatus(200); // Responder a Mercado Pago

    } catch (error) {
        console.error("(HTTPS) !!!!!!!! Error en CATCH procesando webhook de MP !!!!!!!!", error);
        if (error.cause) { console.error("Error Cause:", JSON.stringify(error.cause, null, 2));}
        else { console.error("Error Object:", error); }
        res.sendStatus(200); // Aún así, responde 200 a Mercado Pago
    }
    console.log(`--- (HTTPS) [${new Date().toISOString()}] FIN Webhook /payment-webhook ---`);
});

// Endpoints para las "Pantallas" de Feedback de Mercado Pago (servidos por 'app' sobre HTTPS)
app.get("/payment-feedback", (req, res) => {
    console.log(`\n--- (HTTPS) [${new Date().toISOString()}] INICIO GET /payment-feedback ---`);
    console.log("(HTTPS) Query Params en /payment-feedback:", JSON.stringify(req.query, null, 2));
    // ... (tu código actual de /payment-feedback sin cambios, ya estaba bien) ...
    const { status, vending_txn_id, payment_id, mp_status } = req.query;
    let title = "Estado del Pago";
    let message = `El estado de tu pago para la transacción ${vending_txn_id || 'desconocida'} es: ${status || 'desconocido'}.`;
    let bgColor = "#eee"; let textColor = "#333";
    switch (status) {
        case "success": title = "¡Pago Aprobado!"; message = `Tu pago (ID MP: ${payment_id || 'N/A'}) para la transacción ${vending_txn_id} fue aprobado. Estado MP: ${mp_status}.`; bgColor = "#d4edda"; textColor = "#155724"; break;
        case "failure": title = "Pago Rechazado"; message = `Tu pago (ID MP: ${payment_id || 'N/A'}) para la transacción ${vending_txn_id} fue rechazado. Estado MP: ${mp_status}.`; bgColor = "#f8d7da"; textColor = "#721c24"; break;
        case "pending": title = "Pago Pendiente"; message = `Tu pago (ID MP: ${payment_id || 'N/A'}) para la transacción ${vending_txn_id} está pendiente. Estado MP: ${mp_status}.`; bgColor = "#fff3cd"; textColor = "#856404"; break;
    }
    res.send(`<!DOCTYPE html>...${title}...${message}...</style>...`); // Tu HTML
    console.log(`--- (HTTPS) [${new Date().toISOString()}] FIN GET /payment-feedback (Estado: ${status}) ---`);
});

app.post("/test-webhook", (req, res) => { // Endpoint de prueba en HTTPS
    console.log(`\n--- (HTTPS) [${new Date().toISOString()}] INICIO Webhook /test-webhook ---`);
    console.log("(HTTPS) Headers:", JSON.stringify(req.headers, null, 2));
    console.log("(HTTPS) Cuerpo:", JSON.stringify(req.body, null, 2));
    console.log("(HTTPS) Query:", JSON.stringify(req.query, null, 2));
    res.status(200).json({ message: "Test HTTPS webhook received", body: req.body, query: req.query });
    console.log(`--- (HTTPS) [${new Date().toISOString()}] FIN Webhook /test-webhook ---`);
});


// <<< --- INICIO CONFIGURACIÓN SERVIDOR HTTPS Y WSS --- >>>
// Este es el servidor principal que manejará tanto las solicitudes HTTPS para la API
// como las conexiones WebSocket Seguras (WSS).

let serverToListen; // Variable para el servidor que realmente escuchará

try {
    // Intenta cargar credenciales SSL. Define SSL_KEY_PATH y SSL_CERT_PATH en tu .env
    // o reemplaza con las rutas directas si no usas .env para esto.
    const keyPath = process.env.SSL_KEY_PATH;
    const certPath = process.env.SSL_CERT_PATH;

    if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        console.log("INFO: Cargando credenciales SSL desde las rutas especificadas.");
        const privateKey = fs.readFileSync(keyPath, 'utf8');
        const certificate = fs.readFileSync(certPath, 'utf8');
        const credentials = { key: privateKey, cert: certificate };
        
        serverToListen = https.createServer(credentials, app); // 'app' es tu instancia de Express
        console.log("INFO: Servidor HTTPS creado. Listo para WSS.");
    } else {
        // Este caso es problemático para WSS si no estás detrás de un proxy que maneje SSL.
        // Si estás en un PaaS (Vercel, Heroku) que termina SSL, ellos te dan un puerto HTTP
        // y tu app escucha en HTTP. Las conexiones wss:// externas son convertidas a ws:// internas.
        // PERO, para WebSockets persistentes, las funciones serverless de Vercel pueden no ser ideales.
        console.warn("ADVERTENCIA: No se encontraron archivos de certificado SSL en las rutas especificadas (SSL_KEY_PATH, SSL_CERT_PATH) o no están definidas.");
        if (process.env.NODE_ENV === 'development' || process.env.VERCEL_ENV) {
            console.warn("MODO DESARROLLO o VERCEL: Asumiendo que SSL/TLS es manejado externamente o no es requerido para WS local.");
            console.warn("         Iniciando servidor HTTP para API y WebSockets NO SEGUROS (ws://).");
            console.warn("         ¡¡¡NO USAR ESTA CONFIGURACIÓN HTTP EN PRODUCCIÓN DIRECTAMENTE EXPUESTA!!!");
            serverToListen = http.createServer(app); // Fallback a HTTP (ws://), NO wss://
        } else {
            throw new Error("Error de configuración SSL: Faltan certificados en entorno de producción no PaaS.");
        }
    }
} catch (sslError) {
    console.error("ERROR CRÍTICO CONFIGURANDO SERVIDOR HTTPS/WSS:", sslError);
    console.error("         Asegúrate que las rutas SSL_KEY_PATH y SSL_CERT_PATH sean correctas y los archivos legibles.");
    console.warn("         Intentando iniciar en HTTP como último recurso (INSEGURO PARA PRODUCCIÓN).");
    serverToListen = http.createServer(app); // Fallback MUY inseguro
}


// Adjuntar el servidor WebSocket al servidor HTTP/HTTPS creado
const wss = new WebSocket.Server({ server: serverToListen });
console.log(`Servidor WebSocket (esperando ${serverToListen instanceof https.Server ? 'WSS' : 'WS'}) configurado.`);

wss.on('connection', (ws, req) => {
    let machineId = null;
    const protocol = serverToListen instanceof https.Server ? "WSS" : "WS"; // Para los logs

    try {
        // La URL de conexión será relativa al host. Ej: /?machine_id=VM001 o /ws_path?machine_id=VM001
        const connectingUrl = new URL(req.url, `${protocol.toLowerCase()}://${req.headers.host}`);
        const machineIdFromUrl = connectingUrl.searchParams.get('machine_id');

        if (machineIdFromUrl) {
            machineId = machineIdFromUrl;
            activeMachinesWSS.set(machineId, ws); // Usar el Map para WSS
            console.log(`[${protocol}] Máquina conectada e identificada por URL: ${machineId}`);
            ws.send(JSON.stringify({ type: "connection_ack", status: "success", machineId: machineId, message: `Conectado (${protocol}) como ${machineId}` }));
        } else {
            console.log(`[${protocol}] Nueva conexión esperando identificación por mensaje...`);
            // ws.send(JSON.stringify({ type: "request_identification" })); // Opcional
        }
    } catch (urlError) {
        console.error(`[${protocol}] Error parseando URL de conexión para machine_id:`, urlError, 'URL:', req.url);
        console.log(`[${protocol}] Nueva conexión (URL error) esperando identificación por mensaje...`);
    }

    ws.on('message', (messageBuffer) => {
        const messageString = messageBuffer.toString();
        console.log(`[${protocol}] Mensaje de ${machineId || 'desconocido'}: ${messageString}`);
        try {
            const parsedMessage = JSON.parse(messageString);
            if (!machineId && parsedMessage.type === 'identify' && parsedMessage.machine_id) {
                machineId = parsedMessage.machine_id;
                activeMachinesWSS.set(machineId, ws); // Usar el Map para WSS
                console.log(`[${protocol}] Máquina identificada por mensaje: ${machineId}`);
                ws.send(JSON.stringify({ type: "identification_ack", status: "success", machineId: machineId, message: `Identificado (${protocol}) como ${machineId}`}));
            } else if (parsedMessage.type === 'ping_from_client') {
                ws.send(JSON.stringify({ type: 'pong_to_client', timestamp: Date.now() }));
            }
        } catch (e) {
            console.warn(`[${protocol}] Mensaje de ${machineId || 'desconocido'} no es JSON o falta tipo: ${messageString}`);
        }
    });

    ws.on('close', (code, reason) => {
        if (machineId) {
            activeMachinesWSS.delete(machineId); // Usar el Map para WSS
            console.log(`[${protocol}] Máquina desconectada: ${machineId}. Código: ${code}, Razón: ${reason ? reason.toString() : 'N/A'}`);
        } else {
            console.log(`[${protocol}] Conexión (no identificada) cerrada. Código: ${code}, Razón: ${reason ? reason.toString() : 'N/A'}`);
        }
    });

    ws.on('error', (error) => {
        console.error(`[${protocol}] Error en conexión de ${machineId || 'desconocido'}:`, error);
        if (machineId) {
            activeMachinesWSS.delete(machineId); // Usar el Map para WSS
        }
    });

    // Ping desde el servidor
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping((err) => { if (err) { console.error(`[${protocol}] Error enviando ping a ${machineId || 'desconocido'}:`, err); }});
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);
    ws.on('close', () => clearInterval(pingInterval));
});
// <<< --- FIN CONFIGURACIÓN SERVIDOR HTTPS Y WSS --- >>>


// --- Iniciar el Servidor Principal (HTTPS/HTTP + WSS/WS) ---
if (serverToListen) {
    serverToListen.listen(PORT, () => {
        const serverType = serverToListen instanceof https.Server ? "HTTPS y WSS" : "HTTP y WS (INSEGURO)";
        console.log(`Servidor principal (${serverType}) escuchando en el puerto ${PORT}`);
        if (process.env.BACKEND_URL) {
            console.log(`URL Base (externa): ${process.env.BACKEND_URL}`);
        }
        console.log(`INFO: Este backend está configurado para MODO ${process.env.NODE_ENV === "development" ? 'Sandbox de Desarrollo' : 'Producción'}.`);
        if (serverToListen instanceof http.Server && process.env.NODE_ENV !== 'development') {
            console.error("¡¡¡ADVERTENCIA DE SEGURIDAD CRÍTICA!!! El servidor está en modo HTTP en un entorno que no es desarrollo. ¡DEBE USAR HTTPS/WSS EN PRODUCCIÓN!");
        }
    });
} else {
    console.error("ERROR FATAL: No se pudo determinar o crear una instancia de servidor (http o https). El backend no puede iniciar.");
    process.exit(1); // Salir si no hay servidor para escuchar
}

// El app.listen original ya no es necesario, usamos serverToListen.listen()
// app.listen(PORT, () => { ... });
