require("dotenv").config();
const express = require("express");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");

const app = express();

// Configuración de middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// 1. Configuración de Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
  options: { 
    timeout: 5000,
    idempotencyKey: true 
  }
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

// 2. Configuración de Firebase
const firebaseConfig = {
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
};

admin.initializeApp(firebaseConfig);
const db = admin.firestore();

// 3. Endpoints
app.get("/", (req, res) => {
  res.status(200).json({
    status: "active",
    version: "2.0.0",
    environment: process.env.NODE_ENV || "development"
  });
});

app.post("/create-preference", async (req, res) => {
  try {
    const { machine_id, items, payer } = req.body;

    // Validación básica
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Items array is required" });
    }

    const preferenceData = {
      body: {
        items: items.map(item => ({
          title: item.name.substring(0, 255), // Límite de Mercado Pago
          description: item.description?.substring(0, 255) || "",
          quantity: Number(item.quantity),
          unit_price: Number(item.price),
          currency_id: "MXN",
          picture_url: item.image_url || undefined
        })),
        payer: payer ? {
          name: payer.name?.substring(0, 50),
          email: payer.email,
          phone: {
            number: Number(payer.phone)
          }
        } : undefined,
        external_reference: machine_id,
        payment_methods: {
          excluded_payment_types: [{ id: "atm" }],
          installments: 1
        },
        notification_url: `${process.env.BACKEND_URL}/webhook`,
        back_urls: {
          success: `${process.env.FRONTEND_URL}/payment/success`,
          pending: `${process.env.FRONTEND_URL}/payment/pending`,
          failure: `${process.env.FRONTEND_URL}/payment/error`
        },
        auto_return: "approved",
        statement_descriptor: "MI_NEGOCIO",
        expires: false
      }
    };

    const preference = await preferenceClient.create(preferenceData);

    // Guardar en Firestore
    const transactionRef = db.collection("transactions").doc(preference.id);
    await transactionRef.set({
      machine_id,
      status: "pending",
      items,
      preference_id: preference.id,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).json({
      id: preference.id,
      init_point: preference.sandbox_init_point || preference.init_point,
      sandbox: process.env.NODE_ENV === "development"
    });

  } catch (error) {
    console.error("Error creating preference:", error);
    res.status(500).json({ 
      error: "Error creating payment preference",
      details: process.env.NODE_ENV === "development" ? error.message : null
    });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const { type, data } = req.body;
    
    if (type === "payment") {
      const payment = await paymentClient.get({ id: data.id });
      
      await db.collection("transactions").doc(payment.id).update({
        status: payment.status,
        payment_method: payment.payment_method_id,
        payment_details: admin.firestore.FieldValue.delete(),
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`🔄 Payment ${payment.id} updated to: ${payment.status}`);
      
      if (payment.status === "approved") {
        // Aquí puedes agregar lógica adicional post-pago
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error("Global error handler:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`MercadoPago Sandbox: ${process.env.NODE_ENV === "development"}`);
});
