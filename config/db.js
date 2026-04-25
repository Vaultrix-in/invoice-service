const mongoose = require('mongoose');
module.exports = async () => {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://invoice-db:27017/invoice_db');
    console.log('[invoice-service] MongoDB connected');
};
