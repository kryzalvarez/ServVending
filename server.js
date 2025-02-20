require("dotenv").config();
const express = require("express");
const https = require('https');
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
//tyth
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;

// Credenciales de Firebase desde variables de entorno
const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
};

// Inicializa Firebase con las credenciales de variables de entorno
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
    console.log("Firebase inicializado correctamente.");
} catch (error) {
    console.error("Error al inicializar Firebase:", error);
}

const db = admin.firestore();

// Ruta de inicio para verificar el despliegue
app.get("/", (req, res) => {
    res.send("¡Backend desplegado correctamente!");
});

// Ruta para generar un pago y código QR
app.post("/create-payment", async (req, res) => {
    try {
        const { machine_id, items } = req.body;

        if (!machine_id || !items || !Array.isArray(items)) {
            return res.status(400).json({ error: "Datos de entrada inválidos" });
        }

        const preference = {
            items: items.map(item => ({
                title: item.name,
                quantity: item.quantity,
                currency_id: "MXN",
                unit_price: item.price
            })),
            external_reference: machine_id,
            notification_url: `https://tu-backend.vercel.app/payment-webhook`
        };

        const postData = JSON.stringify(preference);

        const options = {
            hostname: 'api.mercadopago.com',
            path: '/checkout/preferences',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
                'Content-Length': postData.length
            }
        };

        const reqMercadoPago = https.request(options, (resp) => {
            let data = '';

            // A chunk of data has been received.
            resp.on('data', (chunk) => {
                data += chunk;
                console.log("Chunk recibido:", chunk); // Depuración
            });

            // The whole response has been received.
            resp.on('end', async () => {
                console.log("Respuesta completa recibida:", data); // Depuración
                try {
                    const response = JSON.parse(data);
                    console.log("Respuesta de MercadoPago:", response); // Depuración
                    if (!response.id) {
                        return res.status(500).json({ error: "ID de respuesta inválido" });
                    }
                    await db.collection('transactions').doc(response.id).set({
                        machine_id,
                        status: "pending",
                        items
                    });
                    console.log(`Transacción guardada en Firestore con ID: ${response.id}`);

                    res.json({ payment_url: response.init_point, qr_data: response.id });
                } catch (parseError) {
                    console.error("Error al parsear la respuesta de MercadoPago:", parseError);
                    res.status(500).json({ error: "Error al procesar la respuesta de MercadoPago" });
                }
            });
        });

        reqMercadoPago.on('error', (e) => {
            console.error(`Problema con la solicitud a MercadoPago: ${e.message}`);
            res.status(500).json({ error: "Error al crear pago" });
        });

        // Write data to request body
        reqMercadoPago.write(postData);
        reqMercadoPago.end();

    } catch (error) {
        console.error("Error creando pago:", error);
        res.status(500).json({ error: "Error al crear pago" });
    }
});

// Webhook de MercadoPago para recibir confirmación de pago
app.post("/payment-webhook", async (req, res) => {
    try {
        const paymentData = req.body;
        const prefId = paymentData.data.id;

        if (!prefId) {
            return res.sendStatus(400);
        }

        const transactionRef = db.collection('transactions').doc(prefId);
        const doc = await transactionRef.get();

        if (doc.exists) {
            const paymentStatus = paymentData.data.status;

            if (paymentStatus === 'approved') {
                await transactionRef.update({ status: "paid" });
                console.log(`✅ Pago confirmado para la máquina ${doc.data().machine_id}`);
            } else {
                await transactionRef.update({ status: "failed" });
                console.log(`❌ Pago fallido para la máquina ${doc.data().machine_id}`);
            }
        } else {
            console.log(`Transacción no encontrada para ID: ${prefId}`);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Error en webhook:", error);
        res.sendStatus(500);
    }
});

// Ruta para verificar el estado de una transacción
app.get("/transaction-status/:transaction_id", async (req, res) => {
    try {
        const { transaction_id } = req.params;
        if (!transaction_id) {
            return res.status(400).json({ error: "ID de transacción inválido" });
        }
        const transactionRef = db.collection('transactions').doc(transaction_id);
        const doc = await transactionRef.get();

        if (doc.exists) {
            res.json(doc.data());
        } else {
            console.log(`Transacción no encontrada para ID: ${transaction_id}`);
            res.json({ error: "Transacción no encontrada" });
        }
    } catch (error) {
        console.error("Error al obtener el estado de la transacción:", error);
        res.status(500).json({ error: "Error al obtener el estado de la transacción" });
    }
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Backend corriendo en http://localhost:${PORT}`);
});
