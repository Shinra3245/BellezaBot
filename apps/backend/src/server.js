require('dotenv').config();
const express = require('express');
const webhookRoutes = require('./api/webhook');

const app = express();

// Middlewares
app.use(express.json()); // Para parsear body de peticiones como JSON

// Rutas
app.use('/webhook', webhookRoutes);

app.get('/', (req, res) => {
    res.send('¡El backend de BellezaBot está vivo!');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});