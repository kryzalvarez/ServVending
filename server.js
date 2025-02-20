require("dotenv").config();
const express = require("express");
const mercadopago = require("mercadopago");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Configuración de MercadoPago
mercadopago.configure({
  access_token: process.env.MERCADOPAGO_ACCESS_TOKEN,
  sandbox: process.env.NODE_ENV === "development", // Modo sandbox en desarrollo
});

// Configuración de Firebase
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
};

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
  });
  console.log("Firebase inicializado correctamente");
} catch (error) {
  console.error("Error de Firebase:", error);
}

const db = admin.firestore();

// Endpoint de prueba
app.get("/", (req, res) => {
  res.send("Backend operativo ✅");
});

// Creación de preferencia de pago
app.post("/create-payment", async (req, res) => {
  try {
    const { machine_id, items } = req.body;

    if (!machine_id || !items?.length) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    const preference = {
      items: items.map(item => ({
        title: item.name.substring(0, 50), // Limita título a 50 caracteres
        quantity: Number(item.quantity),
        currency_id: "MXN",
        unit_price: Number(item.price)
      })),
      external_reference: machine_id,
      notification_url: `${process.env.BACKEND_URL}/payment-webhook`,
      auto_return: "approved",
      back_urls: {
        success: `${process.env.FRONTEND_URL}/payment-success`,
        failure: `${process.env.FRONTEND_URL}/payment-error`
      }
    };

    const response = await mercadopago.preferences.create(preference);
    
    await db.collection('transactions').doc(response.body.id).set({
      machine_id,
      status: "pending",
      items,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      payment_id: response.body.id,
      payment_url: response.body.init_point,
      sandbox_url: response.body.sandbox_init_point
    });

  } catch (error) {
    console.error("Error completo:", {
      message: error.message,
      stack: error.stack,
      response: error.response?.body
    });
    res.status(500).json({ error: "Error al crear pago", details: error.message });
  }
});

// Webhook de notificaciones
app.post("/payment-webhook", async (req, res) => {
  try {
    const paymentId = req.query.id || req.body.data.id;
    
    if (!paymentId) {
      return res.status(400).send("ID de pago no proporcionado");
    }

    const payment = await mercadopago.payment.findById(paymentId);
    const transactionRef = db.collection('transactions').doc(paymentId);

    await transactionRef.update({
      status: payment.body.status,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      payment_details: payment.body
    });

    console.log(`Estado actualizado a ${payment.body.status} para ${paymentId}`);
    res.sendStatus(200);

  } catch (error) {
    console.error("Error en webhook:", {
      error: error.message,
      body: req.body
    });
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
