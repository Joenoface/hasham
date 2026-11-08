const express = require('express');
const { RouterOSAPI } = require('routeros-api');

function createPppoeRouter(pool) {
    const router = express.Router();

    // 1. Create or Sync PPPoE Profile
    router.post('/profiles', async (req, res) => {
        const { router_id, package_id, profile_name, rate_limit, local_address, remote_address_pool, only_one } = req.body;

        if (!router_id || !package_id || !profile_name) {
            return res.status(400).json({ error: 'router_id, package_id, and profile_name are required.' });
        }

        try {
            // Fetch Router details from DB
            const [routerRows] = await pool.query('SELECT * FROM routers WHERE id = ?', [router_id]);
            if (routerRows.length === 0) return res.status(404).json({ error: 'Router not found.' });
            const dbRouter = routerRows[0];

            // Save/Update in DB first
            await pool.query(
                `INSERT INTO pppoe_profiles (router_id, package_id, profile_name, rate_limit, local_address, remote_address_pool, only_one)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE rate_limit=?, local_address=?, remote_address_pool=?, only_one=?`,
                [router_id, package_id, profile_name, rate_limit, local_address, remote_address_pool, only_one || 'yes',
                 rate_limit, local_address, remote_address_pool, only_one || 'yes']
            );

            // Connect to MikroTik Router OS API
            const conn = new RouterOSAPI({
                host: dbRouter.ip_address,
                port: dbRouter.api_port || 8728,
                user: dbRouter.api_username,
                password: dbRouter.api_password,
                timeout: 10
            });

            await conn.connect();
            const existingProfiles = await conn.write(['/ppp/profile/print', `?name=${profile_name}`]);

            if (existingProfiles && existingProfiles.length > 0) {
                await conn.write([
                    '/ppp/profile/set',
                    `=.id=${existingProfiles[0]['.id']}`,
                    `=rate-limit=${rate_limit || ''}`,
                    `=local-address=${local_address || ''}`,
                    `=remote-address=${remote_address_pool || ''}`,
                    `=only-one=${only_one || 'yes'}`
                ]);
            } else {
                await conn.write([
                    '/ppp/profile/add',
                    `=name=${profile_name}`,
                    `=rate-limit=${rate_limit || ''}`,
                    `=local-address=${local_address || ''}`,
                    `=remote-address=${remote_address_pool || ''}`,
                    `=only-one=${only_one || 'yes'}`
                ]);
            }
            await conn.close();

            res.json({ success: true, message: `PPPoE Profile '${profile_name}' synced successfully to router and database.` });
        } catch (err) {
            console.error('PPPoE Profile Error:', err.message || err);
            res.status(500).json({ error: err.message || 'Failed to create/sync PPPoE profile.' });
        }
    });

    // 2. Register & Provision PPPoE Account User
    router.post('/accounts', async (req, res) => {
        const { user_id, router_id, package_id, username, password, remote_address } = req.body;

        if (!user_id || !router_id || !package_id || !username || !password) {
            return res.status(400).json({ error: 'user_id, router_id, package_id, username, and password are required.' });
        }

        try {
            // Find package to get profile name mapping (or fallback to package name)
            const [pkgRows] = await pool.query('SELECT * FROM packages WHERE id = ?', [package_id]);
            if (pkgRows.length === 0) return res.status(404).json({ error: 'Package not found.' });
            const pkg = pkgRows[0];
            const profileName = pkg.name.replace(/\s+/g, '_');

            // Find Router
            const [routerRows] = await pool.query('SELECT * FROM routers WHERE id = ?', [router_id]);
            if (routerRows.length === 0) return res.status(404).json({ error: 'Router not found.' });
            const dbRouter = routerRows[0];

            // Store inside database pppoe_accounts
            const [result] = await pool.query(
                `INSERT INTO pppoe_accounts (user_id, router_id, package_id, username, password_hash, remote_address, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'active')
                 ON DUPLICATE KEY UPDATE package_id=?, remote_address=?, status='active'`,
                [user_id, router_id, package_id, username, password, remote_address, package_id, remote_address]
            );

            // Provision on MikroTik via API
            const conn = new RouterOSAPI({
                host: dbRouter.ip_address,
                port: dbRouter.api_port || 8728,
                user: dbRouter.api_username,
                password: dbRouter.api_password,
                timeout: 10
            });

            await conn.connect();
            const existingSecrets = await conn.write(['/ppp/secret/print', `?name=${username}`]);

            if (existingSecrets && existingSecrets.length > 0) {
                await conn.write([
                    '/ppp/secret/set',
                    `=.id=${existingSecrets[0]['.id']}`,
                    `=password=${password}`,
                    `=profile=${profileName}`,
                    `=service=pppoe`,
                    `=remote-address=${remote_address || ''}`
                ]);
            } else {
                await conn.write([
                    '/ppp/secret/add',
                    `=name=${username}`,
                    `=password=${password}`,
                    `=profile=${profileName}`,
                    `=service=pppoe`,
                    `=remote-address=${remote_address || ''}`
                ]);
            }
            await conn.close();

            // Create corresponding active user subscription record with service_type = 'pppoe'
            const expiresAt = new Date(Date.now() + (pkg.duration_hours || 720) * 3600 * 1000);
            await pool.query(
                `INSERT INTO user_subscriptions (user_id, router_id, package_id, service_type, status, expires_at)
                 VALUES (?, ?, ?, 'pppoe', 'active', ?)`,
                [user_id, router_id, package_id, expiresAt]
            );

            res.json({ success: true, message: `PPPoE account '${username}' created and provisioned successfully.` });
        } catch (err) {
            console.error('PPPoE Account Provisioning Error:', err.message || err);
            res.status(500).json({ error: err.message || 'Failed to provision PPPoE account.' });
        }
    });

    // 3. Fetch Active Sessions
    router.get('/sessions', async (req, res) => {
        try {
            const [rows] = await pool.query(
                `SELECT s.*, a.username, r.name as router_name
                 FROM pppoe_sessions s
                 JOIN pppoe_accounts a ON s.pppoe_account_id = a.id
                 JOIN routers r ON s.router_id = r.id
                 WHERE s.status = 'connected'`
            );
            res.json(rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Database error fetching PPPoE sessions' });
        }
    });

    return router;
}

module.exports = createPppoeRouter;