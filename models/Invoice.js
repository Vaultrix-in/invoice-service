const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
    invoiceNo:    { type: String, unique: true },
    orderId:      { type: String, required: true, unique: true },
    userId:       { type: String, required: true },
    userName:     { type: String, trim: true },
    userEmail:    { type: String, lowercase: true, trim: true },
    serviceId:    { type: String, required: true },
    serviceName:  { type: String, required: true },
    description:  { type: String, trim: true },
    amount:       { type: Number, required: true },
    address:      { type: String },
    scheduledDate:{ type: Date },
    paidAt:       { type: Date, default: Date.now },
}, { timestamps: true });

// Auto-generate invoice number before save
invoiceSchema.pre('save', async function() {
    if (!this.invoiceNo) {
        const date = new Date();
        const dateStr = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
        const count = await mongoose.model('Invoice').countDocuments();
        this.invoiceNo = `INV-${dateStr}-${String(count + 1).padStart(4, '0')}`;
    }
});

module.exports = mongoose.model('Invoice', invoiceSchema);
