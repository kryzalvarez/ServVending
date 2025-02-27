require('dotenv').config();
const express = require('express');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const app = express();

app.use(cors());
app.use(bodyParser.json());

const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
  options: { sandbox: process.env.NODE_ENV === 'development' }
});

const serviceAccount = JSON.parse(
  Buffer.from(process.env.BASE64_ENCODED_SERVICE_ACCOUNT, 'base64').toString('utf-8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

// Endpoint para crear pago
app.post('/create-payment', async (req, res) => {
  try {
    const { machine_id, items } = req.body;
    
    const preference = await new Preference(client).create({
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
    });

    await db.collection('transactions').doc(preference.id).set({
      machine_id,
      status: 'pending',
      items,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      id: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook para actualizar estado
app.post('/payment-webhook', async (req, res) => {
  try {
    const paymentId = req.body.data.id;
    const payment = await new Payment(client).get({ id: paymentId });

    const updateData = {
      status: payment.status,
      payment_method: payment.payment_method_id,
      amount: payment.transaction_amount,
      last_update: admin.firestore.FieldValue.serverTimestamp(),
      payer_email: payment.payer?.email,
      metadata: {
        approval_url: payment.point_of_interaction?.transaction_data?.ticket_url
      }
    };

    await db.collection('transactions').doc(paymentId).update(updateData);

    // Notificación a máquina
    if (payment.status === 'approved') {
      const machineRef = db.collection('machines').doc(payment.external_reference);
      const machine = await machineRef.get();
      
      if (machine.exists) {
        await admin.messaging().send({
          token: machine.data().fcm_token,
          notification: {
            title: 'Pago Aprobado',
            body: `Monto: $${payment.transaction_amount} MXN`
          }
        });
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// Endpoint para consultar estado
app.get('/payment-status/:paymentId', async (req, res) => {
  try {
    const doc = await db.collection('transactions').doc(req.params.paymentId).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    res.json(doc.data());
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Servidor listo en puerto ${process.env.PORT || 3000}`);
});
