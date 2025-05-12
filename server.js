require("dotenv").config();
const express = require("express");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const app = express();
const PORT = process.env.PORT || 3001; // Puerto diferente al anterior si aún está corriendo

// 1. Configuración de MercadoPago
// Utiliza tu ACCESS TOKEN de PRUEBA (Sandbox) para este ejemplo
const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

if (!accessToken) {
  console.error("Error: MERCADOPAGO_ACCESS_TOKEN no encontrado en .env");
  process.exit(1);
}

const client = new MercadoPagoConfig({
  accessToken: accessToken,
  options: {
    timeout: 5000, // Opcional: tiempo de espera para las solicitudes
    // La opción sandbox se infiere del tipo de token (TEST- vs APP_USR-)
    // o puede ser explícita si NODE_ENV se usa para más que solo esto.
    // Para tokens TEST-xxx, el entorno es inherentemente sandbox.
  }
});

const preferenceClient = new Preference(client);

// Endpoint para crear la preferencia de pago
app.get("/crear-pago-simple", async (req, res) => {
  try {
    console.log("Intentando crear preferencia de pago simple...");

    const preferenceData = {
      body: {
        items: [
          {
            title: "Producto de Prueba Simple",
            quantity: 1,
            unit_price: 10.00, // Precio: 10 pesos
            currency_id: "MXN", // Moneda: Pesos Mexicanos
            description: "Cobro de ejemplo por 10 MXN",
            category_id: "services" // Opcional: categoría del producto
          }
        ],
        payer: { // Información opcional del pagador
            name: "Test",
            surname: "User",
            email: "test_user_123456@testuser.com", // Email de prueba válido
        },
        back_urls: { // URLs de redirección (pueden ser ficticias para este ejemplo simple)
          success: "http://localhost:3001/success",
          failure: "http://localhost:3001/failure",
          pending: "http://localhost:3001/pending"
        },
        auto_return: "approved", // Redirigir automáticamente en caso de pago aprobado
        // Es buena práctica incluir una URL de notificación, aunque para este log no es estrictamente necesaria
        // notification_url: "https://tu-url-publica.com/webhook-mercadopago",
        external_reference: `simple_test_${Date.now()}` // Referencia externa única
      }
    };

    const preference = await preferenceClient.create(preferenceData);

    console.log("--- Preferencia de Pago Creada ---");
    console.log("ID de Preferencia:", preference.id);

    // El SDK v3 devuelve el init_point directamente para el entorno correcto (sandbox o prod)
    // basado en el token. Si usas un token TEST-xxxx, init_point será de sandbox.
    console.log("Link de Pago (init_point):", preference.init_point);

    // sandbox_init_point también se proporciona si el token es de prueba
    if (preference.sandbox_init_point) {
        console.log("Link de Pago (sandbox_init_point):", preference.sandbox_init_point);
    }
    console.log("------------------------------------");

    res.json({
      message: "Preferencia creada. Revisa la consola para ver el link de pago.",
      preferenceId: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point // Enviar también por si acaso
    });

  } catch (error) {
    console.error("Error al crear la preferencia de pago:", error);
    // Para ver más detalles del error de MercadoPago
    if (error.cause) {
        console.error("Causa del error de MercadoPago:", JSON.stringify(error.cause, null, 2));
    }
    res.status(500).json({
        error: "No se pudo crear la preferencia de pago",
        details: error.message,
        cause: error.cause || "No additional cause information"
    });
  }
});

// Rutas de ejemplo para back_urls (solo para demostrar)
app.get("/success", (req, res) => res.send("Pago Exitoso (simulado)"));
app.get("/failure", (req, res) => res.send("Pago Fallido (simulado)"));
app.get("/pending", (req, res) => res.send("Pago Pendiente (simulado)"));

app.listen(PORT, () => {
  console.log(`Servidor simple de MercadoPago escuchando en http://localhost:${PORT}`);
  console.log(`Para generar un cobro de 10 MXN, visita: http://localhost:${PORT}/crear-pago-simple`);
});
