// Punto de arranque del servidor. Valida el entorno (al requerir env) y pone la app a escuchar.
const env = require('./config/env');
const { createApp } = require('./app');

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`[server] BellezaBot escuchando en el puerto ${env.PORT} (${env.NODE_ENV})`);
});
