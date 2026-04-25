require('dotenv').config();
const connectDB = require('./config/db');
const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const Invoice = require('./models/Invoice');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3005;
const ORDER_SERVICE_URLS = Array.from(new Set(
    [
        process.env.ORDER_SERVICE_URL,
        'http://order-service:3002',
        'http://localhost:3002',
        'http://127.0.0.1:3002',
    ]
        .filter(Boolean)
        .map((url) => url.replace(/\/+$/, ''))
));
connectDB();

const ok = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const err = (res, message, status = 400) => res.status(status).json({ success: false, message });

const buildInvoicePayload = (source = {}) => ({
    orderId: source._id || source.orderId,
    userId: source.userId,
    userName: source.userName,
    userEmail: source.userEmail,
    serviceId: source.serviceId,
    serviceName: source.serviceName,
    description: source.description,
    amount: Number(source.amount),
    address: source.address,
    scheduledDate: source.scheduledDate,
    paidAt: source.paidAt || source.updatedAt || new Date(),
});

const invoiceNeedsHydration = (invoice) => {
    if (!invoice) return false;
    return !invoice.userName || !invoice.userEmail || !invoice.description;
};

const createInvoiceFromOrder = async (order) => {
    if (!order) throw new Error('Order payload is required');

    const existing = await Invoice.findOne({ orderId: order._id || order.orderId });
    if (existing) return existing;

    return Invoice.create(buildInvoicePayload(order));
};

const fetchOrderById = async (orderId) => {
    if (typeof fetch !== 'function') {
        const error = new Error('Invoice was not found and this runtime cannot fetch the order details.');
        error.status = 404;
        throw error;
    }

    let lastError = null;

    for (const baseUrl of ORDER_SERVICE_URLS) {
        try {
            const response = await fetch(`${baseUrl}/orders/${orderId}`);
            const payload = await response.json().catch(() => ({}));

            if (response.ok && payload.order) return payload.order;

            const message = payload.message || payload.error || `Order service returned ${response.status}`;
            const error = new Error(message);
            error.status = response.status === 404 ? 404 : 502;
            lastError = error;

            if (response.status === 404) continue;
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError) throw lastError;

    const error = new Error('Invoice not found');
    error.status = 404;
    throw error;
};

const hydrateInvoiceFromOrder = async (invoice, order) => {
    if (!invoice || !order) return invoice;

    let dirty = false;
    const updates = {
        userName: order.userName,
        userEmail: order.userEmail,
        description: order.description,
        serviceName: order.serviceName,
        address: order.address,
        scheduledDate: order.scheduledDate,
    };

    for (const [key, value] of Object.entries(updates)) {
        if (value && String(invoice[key] || '') !== String(value)) {
            invoice[key] = value;
            dirty = true;
        }
    }

    if (dirty) await invoice.save();
    return invoice;
};

const loadInvoiceForOrder = async (orderId) => {
    let invoice = await Invoice.findOne({ orderId });
    if (invoice && !invoiceNeedsHydration(invoice)) return invoice;

    if (invoice) {
        try {
            const order = await fetchOrderById(orderId);
            return hydrateInvoiceFromOrder(invoice, order);
        } catch (error) {
            console.error('[invoice-service] failed to enrich invoice from order:', error.message);
            return invoice;
        }
    }

    const order = await fetchOrderById(orderId);

    const isPaid = String(order.paymentStatus || '').toUpperCase() === 'PAID';
    if (!isPaid) {
        const error = new Error('Invoice is available only after payment is completed.');
        error.status = 409;
        throw error;
    }

    return createInvoiceFromOrder(order);
};

const streamInvoicePdf = (res, invoice) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoiceNo}.pdf"`);
    doc.pipe(res);

    const amount = Number(invoice.amount || 0).toFixed(2);
    const invoiceDate = new Date(invoice.paidAt || invoice.createdAt || Date.now()).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
    });
    const scheduledDate = invoice.scheduledDate
        ? new Date(invoice.scheduledDate).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        })
        : '-';
    const billedToLines = [
        invoice.userName || 'Customer',
        invoice.address || '-',
        invoice.userEmail || '-',
    ];
    const fromLines = [
        'Vaultrix',
        'Service Platform',
        'admin@vaultrix.io',
    ];

    doc.rect(0, 0, 595, 842).fill('#fcfcfc');

    doc.fillColor('#202020').font('Helvetica').fontSize(16).text('VAULTRIX', 50, 42);
    doc.fillColor('#2b2b2b').font('Helvetica').fontSize(11).text(`NO. ${invoice.invoiceNo}`, 420, 44, { align: 'right', width: 125 });

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(50).text('INVOICE', 50, 100);

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(14).text('Date:', 50, 196);
    doc.fillColor('#333333').font('Helvetica').fontSize(14).text(invoiceDate, 95, 196);

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(14).text('Billed to:', 50, 255);
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(14).text('From:', 320, 255);

    doc.fillColor('#333333').font('Helvetica').fontSize(11);
    doc.text(billedToLines.join('\n'), 50, 279, { width: 205, lineGap: 3 });
    doc.text(fromLines.join('\n'), 320, 279, { width: 190, lineGap: 3 });

    const tableTop = 380;
    const tableLeft = 50;
    const tableWidth = 495;
    const colQty = 320;
    const colPrice = 405;
    const colAmount = 490;

    doc.rect(tableLeft, tableTop, tableWidth, 34).fill('#e8e8ea');
    doc.fillColor('#2a2a2a').font('Helvetica').fontSize(12);
    doc.text('Item', 65, tableTop + 11);
    doc.text('Quantity', colQty, tableTop + 11, { width: 70, align: 'center' });
    doc.text('Price', colPrice, tableTop + 11, { width: 60, align: 'center' });
    doc.text('Amount', colAmount, tableTop + 11, { width: 40, align: 'right' });

    const rowTop = tableTop + 54;
    doc.fillColor('#2f2f2f').font('Helvetica').fontSize(12);
    doc.text(invoice.serviceName || invoice.serviceId, 65, rowTop, { width: 230 });
    doc.text('1', colQty, rowTop, { width: 70, align: 'center' });
    doc.text(`$${amount}`, colPrice, rowTop, { width: 60, align: 'center' });
    doc.text(`$${amount}`, colAmount, rowTop, { width: 40, align: 'right' });

    const detailsTop = rowTop + 28;
    doc.fillColor('#7a7a7a').font('Helvetica').fontSize(10);
    doc.text(`Scheduled: ${scheduledDate}`, 65, detailsTop);
    doc.text(`Order ID: ${invoice.orderId}`, 65, detailsTop + 15, { width: 310 });
    if (invoice.description) {
        doc.text(`Note: ${invoice.description}`, 65, detailsTop + 30, { width: 340, lineGap: 2 });
    }

    const totalLineTop = 545;
    doc.moveTo(55, totalLineTop).lineTo(540, totalLineTop).strokeColor('#d5d5d5').lineWidth(1).stroke();
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(12).text('Total', 420, totalLineTop + 14, { width: 60, align: 'right' });
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(12).text(`$${amount}`, 490, totalLineTop + 14, { width: 40, align: 'right' });
    doc.moveTo(55, totalLineTop + 40).lineTo(540, totalLineTop + 40).strokeColor('#e0e0e0').lineWidth(1).stroke();

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(12).text('Payment method:', 50, 615);
    doc.fillColor('#333333').font('Helvetica').fontSize(12).text('Vaultrix Wallet', 160, 615);

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(12).text('Note:', 50, 642);
    doc.fillColor('#333333').font('Helvetica').fontSize(12).text('Thank you for choosing Vaultrix.', 88, 642);

    doc.save();
    doc.fillColor('#d7d9dc');
    doc.moveTo(-30, 785)
        .bezierCurveTo(85, 735, 180, 735, 290, 805)
        .lineTo(0, 842)
        .lineTo(0, 785)
        .fill();
    doc.restore();

    doc.save();
    doc.fillColor('#4b4c4c');
    doc.moveTo(30, 842)
        .bezierCurveTo(155, 748, 350, 705, 555, 770)
        .lineTo(595, 800)
        .lineTo(595, 842)
        .closePath()
        .fill();
    doc.restore();

    doc.end();
};

app.post('/invoices', async (req, res) => {
    try {
        const { orderId, userId, serviceId, serviceName, amount } = req.body;
        if (!orderId || !userId || !serviceId || !serviceName || !amount)
            return err(res, 'Missing required fields');

        const existing = await Invoice.findOne({ orderId });
        if (existing) return ok(res, { invoice: existing });

        const invoice = await Invoice.create(buildInvoicePayload(req.body));
        ok(res, { invoice }, 201);
    } catch (e) {
        err(res, e.message, 500);
    }
});

app.get('/invoices/order/:orderId', async (req, res) => {
    try {
        const invoice = await loadInvoiceForOrder(req.params.orderId);
        ok(res, { invoice });
    } catch (e) {
        err(res, e.message, e.status || 500);
    }
});

app.get('/invoices/order/:orderId/download', async (req, res) => {
    try {
        const invoice = await loadInvoiceForOrder(req.params.orderId);
        streamInvoicePdf(res, invoice);
    } catch (e) {
        err(res, e.message, e.status || 500);
    }
});

app.get('/invoices/:id', async (req, res) => {
    try {
        let invoice = await Invoice.findById(req.params.id);
        if (!invoice) return err(res, 'Invoice not found', 404);
        if (invoiceNeedsHydration(invoice)) {
            try {
                const order = await fetchOrderById(invoice.orderId);
                invoice = await hydrateInvoiceFromOrder(invoice, order);
            } catch (error) {
                console.error('[invoice-service] failed to enrich invoice by id:', error.message);
            }
        }
        ok(res, { invoice });
    } catch (e) {
        err(res, e.message, 500);
    }
});

app.get('/invoices/:id/download', async (req, res) => {
    try {
        let invoice = await Invoice.findById(req.params.id);
        if (!invoice) return err(res, 'Invoice not found', 404);
        if (invoiceNeedsHydration(invoice)) {
            try {
                const order = await fetchOrderById(invoice.orderId);
                invoice = await hydrateInvoiceFromOrder(invoice, order);
            } catch (error) {
                console.error('[invoice-service] failed to enrich invoice PDF payload:', error.message);
            }
        }
        streamInvoicePdf(res, invoice);
    } catch (e) {
        console.error('[invoice-service] PDF error:', e.message);
        err(res, e.message, 500);
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'invoice-service' }));
app.listen(PORT, '0.0.0.0', () => console.log(`[invoice-service] running on port ${PORT}`));
