require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const app = express();

// --- TRUST PROXY SETTING ---
app.set('trust proxy', 1);

// --- SECURITY & MIDDLEWARES ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Rate Limiters
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests from this IP, please try again later.' }
});
app.use('/api/', limiter);

const paymentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: 'Too many payment requests, please try again in a minute.' }
});

// --- DATABASE CONNECTION POOL ---
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 4000,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
    }
});

// --- API ENDPOINTS ---

app.get('/api/packages', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM packages ORDER BY price ASC');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error while fetching packages' });
    }
});

app.post('/api/pay', paymentLimiter, async (req, res) => {
    const { name, email, phone, package_id, client_ip, client_mac } = req.body;
    console.log("Payment payload received -> IP:", client_ip, "| MAC:", client_mac);

    if (!name || !email || !phone || !package_id) {
        return res.status(400).json({ error: 'All fields (name, email, phone, package_id) are required.' });
    }

    try {
        const [pkgRows] = await pool.query('SELECT * FROM packages WHERE id = ?', [package_id]);
        if (pkgRows.length === 0) return res.status(404).json({ error: 'Package not found.' });
        const pkg = pkgRows[0];

        let [userRows] = await pool.query('SELECT id FROM users WHERE email = ? OR phone_number = ?', [email, phone]);
        let userId;
        if (userRows.length > 0) {
            userId = userRows[0].id;
        } else {
            const [userResult] = await pool.query(
                'INSERT INTO users (name, email, phone_number, password_hash, role) VALUES (?, ?, ?, ?, ?)',
                [name, email, phone, 'AUTO_GENERATED_HOTSPOT_USER', 'customer']
            );
            userId = userResult.insertId;
        }

        const reference = `HS_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const amountInCents = Math.round(Number(pkg.price) * 100);

        await pool.query(
            'INSERT INTO transactions (user_id, package_id, gateway, reference, amount, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, pkg.id, 'paystack', reference, pkg.price, pkg.currency || 'KES', 'pending']
        );

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amountInCents,
                reference: reference,
                currency: pkg.currency || 'KES',
                channels: ['mobile_money', 'card'],
                metadata: {
                    user_id: userId,
                    package_id: pkg.id,
                    phone: phone,
                    client_ip: client_ip || '',
                    client_mac: client_mac || '',
                    custom_fields: [
                        { display_name: "Customer Name", variable_name: "customer_name", value: name },
                        { display_name: "Phone Number", variable_name: "phone_number", value: phone }
                    ]
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            status: true,
            access_code: paystackResponse.data.data.access_code,
            reference: reference,
            amount: amountInCents,
            currency: pkg.currency || 'KES',
            public_key: process.env.PAYSTACK_PUBLIC_KEY // Make sure this is configured in Render environment variables
        });

    } catch (err) {
        console.error('Payment Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to initialize payment gateway.' });
    }
});

app.get('/api/status/:reference', async (req, res) => {
    const { reference } = req.params;
    try {
        const [txRows] = await pool.query(
            `SELECT t.*, u.name as customer_name, p.name as package_name, s.expires_at, s.status as sub_status
             FROM transactions t
             JOIN users u ON t.user_id = u.id
             LEFT JOIN packages p ON t.package_id = p.id
             LEFT JOIN user_subscriptions s ON s.transaction_id = t.id
             WHERE t.reference = ?`,
            [reference]
        );

        if (txRows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found.' });
        }

        res.json(txRows[0]);
    } catch (err) {
        console.error('Status fetch error:', err);
        res.status(500).json({ error: 'Server error fetching status.' });
    }
});

app.post('/api/webhook/paystack', async (req, res) => {
    const event = req.body;
    console.log('Webhook received event:', event.event);

    if (event.event === 'charge.success') {
        const data = event.data;
        const reference = data.reference;
        const metadata = data.metadata || {};

        console.log(`Processing successful payment for reference: ${reference}`);

        try {
            const [txRows] = await pool.query('SELECT * FROM transactions WHERE reference = ?', [reference]);
            if (txRows.length === 0) {
                console.error(`Transaction not found in DB: ${reference}`);
                return res.sendStatus(404);
            }
            const transaction = txRows[0];

            if (transaction.status === 'success') {
                console.log(`Transaction ${reference} already processed.`);
                return res.sendStatus(200);
            }

            await pool.query('UPDATE transactions SET status = ?, gateway_response = ? WHERE reference = ?',
                ['success', JSON.stringify(data), reference]);

            const userId = metadata.user_id || transaction.user_id;
            const packageId = metadata.package_id || transaction.package_id;
            const clientIp = metadata.client_ip || '';
            const clientMac = metadata.client_mac || '';

            const [pkgRows] = await pool.query('SELECT * FROM packages WHERE id = ?', [packageId]);
            if (pkgRows.length === 0) {
                console.error(`Package ID ${packageId} not found.`);
                return res.sendStatus(400);
            }
            const pkg = pkgRows[0];
            const durationHours = pkg.duration_hours || 24;
            const expiresAt = new Date(Date.now() + (durationHours * 3600 * 1000));

            const [routerRows] = await pool.query("SELECT * FROM routers WHERE status = 'online' LIMIT 1");
            if (routerRows.length === 0) {
                console.error('CRITICAL: No online routers found in database table `routers`!');
                return res.status(500).json({ error: 'No online routers available for provisioning.' });
            }

            const router = routerRows[0];

            await pool.query(
                'INSERT INTO user_subscriptions (user_id, router_id, package_id, transaction_id, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
                [userId, router.id, packageId, transaction.id, 'active', expiresAt]
            );

            const [userRows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
            const customer = userRows[0];
            const username = customer.email.split('@')[0] + '_' + customer.id;
            const password = customer.phone_number || '123456';

            const bridgeUrl = process.env.WINDOWS_BRIDGE_URL || 'http://localhost:5000/provision-user';

            console.log(`Forwarding provisioning request for ${username} to Windows local bridge...`);

            await axios.post(bridgeUrl, {
                username: username,
                password: password,
                profile: pkg.speed_limit ? 'standard-user' : 'default',
                comment: `Paid via Paystack Ref: ${reference}`,
                client_ip: clientIp,
                client_mac: clientMac
            });

            console.log(`Successfully dispatched hotspot user ${username} to Windows bridge!`);

            return res.sendStatus(200);
        } catch (dbErr) {
            console.error('Webhook fulfillment error details:', dbErr.response?.data || dbErr.message);
            return res.status(500).json({ error: dbErr.message });
        }
    }

    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Hasham Hotspot Server running securely on port ${PORT}`);
});