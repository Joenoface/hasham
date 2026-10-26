require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const { RouterOSAPI } = require('routeros-api');

const app = express();

// --- TRUST PROXY SETTING (Fixes express-rate-limit X-Forwarded-For error) ---
app.set('trust proxy', 1);

// --- SECURITY & MIDDLEWARES ---
app.use(helmet({ contentSecurityPolicy: false })); // Allow inline scripts/styles for single-file UI
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve frontend from 'public' folder

// General Rate Limiter to prevent DDoS
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests from this IP, please try again later.' }
});
app.use('/api/', limiter);

// Strict rate limiter for payment initialization
const paymentLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
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
        // This ensures Node trusts standard secure cloud roots
        minVersion: 'TLSv1.2'
    }
});

// --- API ENDPOINTS ---

// 1. Get all available packages
app.get('/api/packages', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM packages ORDER BY price ASC');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error while fetching packages' });
    }
});

// 2. Initialize Payment (Paystack supporting M-Pesa / Mobile Money)
app.post('/api/pay', paymentLimiter, async (req, res) => {
    const { name, email, phone, package_id } = req.body;

    if (!name || !email || !phone || !package_id) {
        return res.status(400).json({ error: 'All fields (name, email, phone, package_id) are required.' });
    }

    try {
        // Fetch package details
        const [pkgRows] = await pool.query('SELECT * FROM packages WHERE id = ?', [package_id]);
        if (pkgRows.length === 0) return res.status(404).json({ error: 'Package not found.' });
        const pkg = pkgRows[0];

        // Check or create user in DB
        let [userRows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
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
        const amountInCents = Math.round(Number(pkg.price) * 100); // Paystack expects amount in kobo/cents
        const appUrl = process.env.APP_URL || 'http://localhost:3000';

        // Record pending transaction
        await pool.query(
            'INSERT INTO transactions (user_id, package_id, gateway, reference, amount, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, pkg.id, 'paystack', reference, pkg.price, pkg.currency || 'KES', 'pending']
        );

        // Call Paystack Transaction Initialize API
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amountInCents,
                reference: reference,
                currency: pkg.currency || 'KES',
                channels: ['mobile_money', 'card'],
                callback_url: `${appUrl}/success.html?reference=${reference}`,
                metadata: {
                    user_id: userId,
                    package_id: pkg.id,
                    phone: phone,
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
            authorization_url: paystackResponse.data.data.authorization_url,
            reference: reference
        });

    } catch (err) {
        console.error('Payment Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to initialize payment gateway.' });
    }
});

// 3. Check Payment & Subscription Status for Success Page
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

// 4. Paystack Webhook Handler (Automates fulfillment upon successful M-Pesa payment)
// 4. Paystack Webhook Handler (With detailed diagnostic logging)
app.post('/api/webhook/paystack', async (req, res) => {
    const event = req.body;
    console.log('Webhook received event:', event.event);

    if (event.event === 'charge.success') {
        const data = event.data;
        const reference = data.reference;
        const metadata = data.metadata || {};

        console.log(`Processing successful payment for reference: ${reference}`);

        try {
            // Update transaction status
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

            // Get package validity duration
            const [pkgRows] = await pool.query('SELECT * FROM packages WHERE id = ?', [packageId]);
            if (pkgRows.length === 0) {
                console.error(`Package ID ${packageId} not found.`);
                return res.sendStatus(400);
            }
            const pkg = pkgRows[0];
            const durationHours = pkg.duration_hours || 24;
            const expiresAt = new Date(Date.now() + durationHours * 3600 * 1000);

            // Fetch an active online router to provision user
            const [routerRows] = await pool.query("SELECT * FROM routers WHERE status = 'online' LIMIT 1");

            if (routerRows.length === 0) {
                console.error('CRITICAL: No online routers found in the database table `routers`!');
                return res.status(500).json({ error: 'No online routers available for provisioning.' });
            }

            const router = routerRows[0];
            console.log(`Target Router Found: ${router.ip_address}:${router.api_port || 8728}`);

            // Save Subscription
            await pool.query(
                'INSERT INTO user_subscriptions (user_id, router_id, package_id, transaction_id, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
                [userId, router.id, packageId, transaction.id, 'active', expiresAt]
            );

            // Get user details for MikroTik
            const [userRows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
            const customer = userRows[0];
            const username = customer.email.split('@')[0] + '_' + customer.id;
            const password = customer.phone_number || '123456';

            // Push user directly to MikroTik Router via RouterOS API
            const conn = new RouterOSAPI({
                host: router.ip_address,
                port: Number(router.api_port) || 8728,
                user: router.api_username,
                password: router.api_password,
                timeout: 10
            });

            console.log(`Connecting to MikroTik API at ${router.ip_address}...`);
            await conn.connect();

            // Add Hotspot User
            await conn.write('/ip/hotspot/user/add', {
                name: username,
                password: password,
                profile: pkg.speed_limit ? 'standard-user' : 'default',
                comment: `Paid via Paystack M-Pesa Ref: ${reference}`
            });
            await conn.close();
            console.log(`Successfully created hotspot user ${username} on MikroTik router!`);

            return res.sendStatus(200);
        } catch (dbErr) {
            console.error('Webhook fulfillment error details:', dbErr);
            return res.status(500).json({ error: dbErr.message });
        }
    }

    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Hasham Hotspot Server running securely on port ${PORT}`);
});