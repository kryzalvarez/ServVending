require("dotenv").config();
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
//ggg
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// 1. Configuración de MercadoPago (Versión Nueva)
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
  options: { sandbox: process.env.NODE_ENV === "development" }
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

// 2. Configuración de Firebase
const base64EncodedServiceAccount = process.env.BASE64_ENCODED_SERVICE_ACCOUNT;
const decodedServiceAccount = Buffer.from(base64EncodedServiceAccount, 'base64').toString('utf-8');
const serviceAccount = JSON.parse(decodedServiceAccount);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

// 3. Endpoints
app.get("/", (req, res) => {
  res.send("Backend MercadoPago v2 🚀");
});

app.post("/create-payment", async (req, res) => {
  try {
    const { machine_id, items } = req.body;

    const preferenceData = {
      body: {
        items: items.map(item => ({
          title: item.name.substring(0, 50),
          quantity: Number(item.quantity),
          currency_id: "MXN",
          unit_price: Number(item.price)
        })),
        external_reference: machine_id,
        notification_url: `${process.env.BACKEND_URL}/payment-webhook`,
        back_urls: {
          success: `${process.env.FRONTEND_URL}/success`,
          failure: `${process.env.FRONTEND_URL}/error`
        },
        auto_return: "approved"
      }
    };

    const preference = await preferenceClient.create(preferenceData);

    await db.collection("transactions").doc(preference.id).set({
      machine_id,
      status: "pending",
      items,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      id: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point
    });

  } catch (error) {
    console.error("Error al crear pago:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/payment-webhook", async (req, res) => {
  try {
    const paymentId = req.body.data.id;

    const payment = await paymentClient.get({ id: paymentId });

    await db.collection("transactions").doc(paymentId).update({
      status: payment.status,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      payment_details: payment
    });

    console.log(`✅ Pago ${paymentId} actualizado a: ${payment.status}`);
    res.sendStatus(200);

  } catch (error) {
    console.error("Error en webhook:", error);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
