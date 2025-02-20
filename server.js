require('dotenv').config();
const express = require('express');
const firebaseAdmin = require('firebase-admin');
const cors = require('cors');

// Inicializar Firebase Admin con archivo JSON
try {
  console.log('Inicializando Firebase Admin...');
  const serviceAccount = require('./serviceAccountKey.json');

  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(serviceAccount),
  });

  console.log('Firebase Admin inicializado correctamente');
} catch (error) {
  console.error('Error al inicializar Firebase Admin:', error.message);
  process.exit(1);
}

const app = express();

// Middleware para ignorar el cuerpo en la ruta GET /ganancias/:montableId
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.startsWith('/ganancias/')) {
    req.body = {}; // Asignar un objeto vacío al cuerpo
  }
  next();
});

app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
  console.log(`Solicitud recibida: ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente');
});


app.post('/register-esp32', async (req, res) => {
    const { uuid } = req.body;
    const adminId = 'foALW48LQ8Oxga15NkstBmllbqH2';

    if (!uuid || uuid === "") {
        return res.status(400).send({ error: 'El UUID del ESP32 es requerido.' });
    }

    try {
        const db = firebaseAdmin.firestore();
        const ref = db.collection('montables').doc(uuid);
        const doc = await ref.get();

        if (doc.exists) {
            // Actualizar el adminId si el documento ya existe
            await ref.update({ usuario: adminId });
            return res.status(200).send({ message: 'ESP32 actualizado correctamente con el adminId.' });
        } else {
            // Crear un nuevo documento si no existe
            await ref.set({
                usuario: adminId,
                estado: 'inactivo',
                ultimaActualizacion: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                totalDinero: 0,
                ingresos: [],
                ubicacion: null,
            });

            // Registrar el estado inicial del montable
            const cambiosEstadoRef = ref.collection('cambiosEstado');
            await cambiosEstadoRef.add({
                estado: 'inactivo',
                fecha: firebaseAdmin.firestore.FieldValue.serverTimestamp()
            });

            return res.status(200).send({ message: 'ESP32 registrado correctamente con el adminId.' });
        }
    } catch (error) {
        console.error("Error al registrar/actualizar ESP32:", error);
        return res.status(500).send({ error: 'Error al registrar/actualizar ESP32.' });
    }
});



app.post('/link-montable', async (req, res) => {
  const { uuid, userId, nombre } = req.body;

  if (!uuid || !userId) {
    return res.status(400).send({ error: 'Faltan datos: uuid y userId son requeridos.' });
  }

  try {
    const db = firebaseAdmin.firestore();
    const montableRef = db.collection('montables').doc(uuid);
    const snapshot = await montableRef.get();

    if (!snapshot.exists) {
      return res.status(404).send({ error: 'Montable no encontrado.' });
    }

    const montableData = snapshot.data();

    await montableRef.update({ usuario: userId });

    const userMontableRef = db.collection('usuarios').doc(userId).collection('montables').doc(uuid);
    await userMontableRef.set({
      nombre: nombre || montableData.nombre || 'Sin Nombre',
      estado: montableData.estado || 'inactivo',
      totalDinero: montableData.totalDinero || 0,
      ubicacion: montableData.ubicacion || null,
      ultimaActualizacion: montableData.ultimaActualizacion || null,
    });

    res.status(200).send({ message: 'Montable vinculado correctamente al usuario.' });
  } catch (error) {
    console.error("Error al vincular montable:", error);
    res.status(500).send({ error: 'Error al vincular montable.' });
  }
});


app.post('/update-location', async (req, res) => {
  console.log("Cuerpo de la petición:", req.body);

  const { uniqueId, lat, lng, coins } = req.body;

  if (!uniqueId || lat == null || lng == null || coins == null) {
    return res.status(400).send({ error: 'Faltan datos: uniqueId, lat, lng y coins son requeridos.' });
  }

  try {
    const db = firebaseAdmin.firestore();
    const montableRef = db.collection('montables').doc(uniqueId);
    const snapshot = await montableRef.get();

    if (!snapshot.exists) {
      return res.status(404).send({ error: 'Montable no encontrado.' });
    }

    const montableData = snapshot.data();
    const ubicacion = new firebaseAdmin.firestore.GeoPoint(lat, lng);

    // Actualizar el total de dinero
    const nuevoTotalDinero = (montableData.totalDinero || 0) + coins;

    // Guardar ganancias en la colección `ganancias`
    const gananciasRefSemana = db.collection('ganancias').doc();
    await gananciasRefSemana.set({
      montableId: uniqueId,
      fechaInicio: inicioSemana(),
      fechaFin: finSemana(),
      ganancias: coins,
      tipo: 'semana',
    });

    const gananciasRefMes = db.collection('ganancias').doc();
    await gananciasRefMes.set({
      montableId: uniqueId,
      fechaInicio: inicioMes(),
      fechaFin: finMes(),
      ganancias: coins,
      tipo: 'mes',
    });

    const updatedData = {
      ubicacion: ubicacion,
      ultimaActualizacion: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      totalDinero: nuevoTotalDinero,
      ingresos: firebaseAdmin.firestore.FieldValue.arrayUnion({
        fecha: new Date(),
        cantidad: coins
      }),
      estado: 'activo'
    };

    await montableRef.update(updatedData);

    // Registrar el cambio de estado a 'activo'
    const cambiosEstadoRef = montableRef.collection('cambiosEstado');
    await cambiosEstadoRef.add({
        estado: 'activo',
        fecha: firebaseAdmin.firestore.FieldValue.serverTimestamp()
    });

    if (montableData.usuario) {
      const userMontableRef = db.collection('usuarios').doc(montableData.usuario).collection('montables').doc(uniqueId);
      await userMontableRef.update(updatedData);
    }

    res.status(200).send({ message: 'Ubicación y monedas actualizadas correctamente.' });
  } catch (error) {
    console.error("Error al actualizar la ubicación:", error);
    if (error.code == 'permission-denied') {
      res.status(403).send({ error: 'No tienes permiso para actualizar la ubicación.' });
    } else {
      res.status(500).send({ error: 'Error al actualizar la ubicación.' });
    }
  }
});


app.get('/location/:uniqueId', async (req, res) => {
  const { uniqueId } = req.params;

  if (!uniqueId) {
    return res.status(400).send({ error: 'El uniqueId es requerido.' });
  }

  try {
    const db = firebaseAdmin.firestore();
    const montableRef = db.collection('montables').doc(uniqueId);
    const snapshot = await montableRef.get();

    if (!snapshot.exists) {
      return res.status(404).send({ error: 'Montable no encontrado.' });
    }

    const data = snapshot.data();
    if (!data.ubicacion) {
      return res.status(404).send({ error: 'Ubicación no disponible.' });
    }

    res.status(200).send({
      lat: data.ubicacion.latitude,
      lng: data.ubicacion.longitude,
      ultimaActualizacion: data.ultimaActualizacion,
    });
  } catch (error) {
    console.error("Error al obtener la ubicación:", error);
    res.status(500).send({ error: 'Error al obtener la ubicación.' });
  }
});

// Nueva ruta para obtener las ganancias por rango de fechas
app.get('/ganancias/:montableId/:fechaInicio/:fechaFin', async (req, res) => {
  const { montableId, fechaInicio, fechaFin } = req.params;

  // Convertir las fechas de String (yyyy-MM-dd) a objetos Date
  const fechaInicioDate = new Date(fechaInicio);
  const fechaFinDate = new Date(fechaFin);

  // Ajustar la fechaFinDate para que incluya todo el día
  fechaFinDate.setHours(23, 59, 59, 999);

  try {
    const db = firebaseAdmin.firestore();
    const gananciasRef = db.collection('ganancias');

    const ganancias = await gananciasRef
      .where('montableId', '==', montableId)
      .where('fechaInicio', '>=', fechaInicioDate)
      .where('fechaInicio', '<=', fechaFinDate)
      .orderBy('fechaInicio', 'desc')
      .get();

    const historial = ganancias.docs.map(doc => {
      const data = doc.data();
      const fechaInicio = data.fechaInicio.toDate();
      const fechaFin = data.fechaFin.toDate();
      return {
        ...data,
        fechaInicio: fechaInicio.toISOString(), // Formato ISO 8601
        fechaFin: fechaFin.toISOString(),
        id: doc.id,
      };
    });

    res.status(200).send(historial);
  } catch (error) {
    console.error("Error al obtener el historial de ganancias por rango de fechas:", error);
    res.status(500).send({ error: 'Error al obtener el historial de ganancias por rango de fechas.' });
  }
});

// Función para obtener los uniqueId de los ESP32
const obtenerUniqueIdsDeESP32 = async () => {
  // Obtener los IDs de la colección "montables"
  const db = firebaseAdmin.firestore();
  const montablesRef = db.collection('montables');
  const snapshot = await montablesRef.get();
  const uniqueIds = [];
  snapshot.forEach(doc => {
    uniqueIds.push(doc.id);
  });
  return uniqueIds;
};

// Nueva ruta para obtener las ganancias por mes
app.get('/ganancias-mes/:montableId/:mes/:anio', async (req, res) => {
    const { montableId, mes, anio } = req.params;
    const mesInt = parseInt(mes);
    const anioInt = parseInt(anio);

    try {
        const db = firebaseAdmin.firestore();
        const gananciasRef = db.collection('ganancias');

        const primerDiaMes = new Date(anioInt, mesInt - 1, 1);
        const ultimoDiaMes = new Date(anioInt, mesInt, 0, 23, 59, 59, 999);

        console.log('montableId:', montableId); // Añadir log del montableId
        console.log('Mes Consultado:', mesInt);   // Añadir log del mes consultado
        console.log('Año Consultado:', anioInt);   // Añadir log del año consultado
        console.log('Primer día del mes:', primerDiaMes); // Log del primer día
        console.log('Último día del mes:', ultimoDiaMes);   // Log del último día

        const gananciasSnapshot = await gananciasRef
            .where('montableId', '==', montableId)
            .where('fechaInicio', '>=', primerDiaMes)
            .where('fechaInicio', '<=', ultimoDiaMes)
            .get();


        const historial = gananciasSnapshot.docs.map(doc => {
            const data = doc.data();
            const fechaInicio = data.fechaInicio.toDate(); // Convertir a Date para log
            const fechaFin = data.fechaFin.toDate();     // Convertir a Date para log

            console.log('Documento Ganancia ID:', doc.id); // Log del ID del documento
            console.log('Fecha Inicio Documento:', fechaInicio); // Log de fecha inicio del documento
            console.log('Fecha Fin Documento:', fechaFin);   // Log de fecha fin del documento
            console.log('Ganancias Documento:', data.ganancias); // Log de ganancias del documento


            return {
                ...data,
                fechaInicio: fechaInicio.toISOString(),
                fechaFin: fechaFin.toISOString(),
                id: doc.id,
            };
        });

        console.log('Historial de ganancias encontrado:', historial); // Log del historial encontrado

        res.status(200).send(historial);
    } catch (error) {
        console.error("Error al obtener el historial de ganancias por mes:", error);
        res.status(500).send({ error: 'Error al obtener el historial de ganancias por mes.' });
    }
});
// Función para verificar el estado de los ESP32
const verificarEstadoESP32 = async () => {
    const db = firebaseAdmin.firestore();
    const montablesRef = db.collection('montables');

    // Obtener todos los uniqueId de los ESP32
    const uniqueIds = await obtenerUniqueIdsDeESP32();

    const now = new Date();
    const threshold = 180000; // 3 minutos en milisegundos

    // Iterar sobre los uniqueIds
    for (const uniqueId of uniqueIds) {
        try {
            const docRef = montablesRef.doc(uniqueId);
            const doc = await docRef.get();

            if (doc.exists) {
                const data = doc.data();
                const lastUpdate = data.ultimaActualizacion.toDate();
                const diff = now.getTime() - lastUpdate.getTime();

                if (diff > threshold && data.estado === 'activo') {
                    console.log(`ESP32 ${uniqueId} inactivo. Actualizando estado...`);
                    await docRef.update({ estado: 'inactivo' });

                    // Registrar el cambio de estado a 'inactivo'
                    const cambiosEstadoRef = docRef.collection('cambiosEstado');
                    await cambiosEstadoRef.add({
                        estado: 'inactivo',
                        fecha: firebaseAdmin.firestore.FieldValue.serverTimestamp()
                    });
                }
            } else {
                console.log(`ESP32 ${uniqueId} no encontrado en Firestore.`);
            }
        } catch (error) {
            console.error(`Error al verificar el estado del ESP32 ${uniqueId}:`, error);
        }
    }
};

// Ejecutar verificarEstadoESP32 cada 5 minutos
setInterval(verificarEstadoESP32, 300000); // 300000 milisegundos = 5 minutos

// Funciones auxiliares para calcular fechas
function inicioSemana() {
  const hoy = new Date();
  const diaSemana = hoy.getDay();
  const inicio = new Date(hoy.setDate(hoy.getDate() - diaSemana));
  return inicio;
}

function finSemana() {
  const hoy = new Date();
  const diaSemana = hoy.getDay();
  const fin = new Date(hoy.setDate(hoy.getDate() - diaSemana + 6));
  return fin;
}

function inicioMes() {
  const hoy = new Date();
  return new Date(hoy.getFullYear(), hoy.getMonth(), 1);
}

function finMes() {
  const hoy = new Date();
  return new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
}

// Nueva ruta para obtener el historial de estado por mes
// Nueva ruta para obtener el historial de estado por mes
app.get('/historial-estado/:montableId/:mes/:anio', async (req, res) => {
    const { montableId, mes, anio } = req.params;
    const mesInt = parseInt(mes);
    const anioInt = parseInt(anio);

    try {
        const db = firebaseAdmin.firestore();
        const cambiosEstadoRef = db.collection('montables').doc(montableId).collection('cambiosEstado');

        // Obtener el primer y último día del mes
        const primerDia = new Date(anioInt, mesInt - 1, 1);
        const ultimoDia = new Date(anioInt, mesInt, 0);
        ultimoDia.setHours(23, 59, 59, 999);

        const cambiosEstado = await cambiosEstadoRef
            .where('fecha', '>=', primerDia)
            .where('fecha', '<=', ultimoDia)
            .orderBy('fecha', 'asc')
            .get();

        const diasDelMes = {};
        
        // Obtener la fecha actual para compararla con los días del mes
        const fechaActual = new Date();

        // Inicializar todos los días del mes con el estado "Desconocido" si es futuro, o "inactivo" si es pasado o presente.
        const numDiasMes = ultimoDia.getDate();
        for (let i = 1; i <= numDiasMes; i++) {
            const fechaDia = new Date(anioInt, mesInt - 1, i);
            if (fechaDia > fechaActual) {
                diasDelMes[i] = "desconocido"; // Usar "desconocido" para días futuros
            } else {
                diasDelMes[i] = "inactivo"; // Usar "inactivo" para días pasados o presentes
            }
        }

        // Iterar para aplicar los cambios de estado.
        let estadoActual = diasDelMes[1]; // Iniciar con el estado del primer día
        cambiosEstado.forEach(doc => {
            const data = doc.data();
            const fechaCambio = data.fecha.toDate();
            const diaCambio = fechaCambio.getDate();
            estadoActual = data.estado;

            // Actualizar el estado para los días posteriores al cambio, solo si no es futuro.
            for (let i = diaCambio; i <= numDiasMes; i++) {
                const fechaDia = new Date(anioInt, mesInt - 1, i);
                if (fechaDia <= fechaActual) {
                    diasDelMes[i] = estadoActual;
                }
            }
        });

        res.status(200).send({
            montableId: montableId,
            mes: mesInt,
            anio: anioInt,
            dias: diasDelMes
        });

    } catch (error) {
        console.error("Error al obtener el historial de estado del montable:", error);
        res.status(500).send({ error: 'Error al obtener el historial de estado del montable.' });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
