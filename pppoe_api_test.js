const axios = require('axios');

const BASE_URL = process.env.SERVER_URL || 'http://localhost:3000/api';

async function runTests() {
    console.log('=============================================');
    console.log('Starting PPPoE API Endpoint Test Script...');
    console.log('=============================================');

    try {
        // 1. Test fetching packages
        console.log('\n[1] Testing GET /api/packages...');
        const pkgRes = await axios.get(`${BASE_URL}/packages`);
        console.log(`Success! Found ${pkgRes.data.length} packages.`);
        const samplePkg = pkgRes.data[0];

        // 2. Test PPPoE Profile Creation
        console.log('\n[2] Testing POST /api/pppoe/profiles...');
        const profileRes = await axios.post(`${BASE_URL}/pppoe/profiles`, {
            router_id: 1,
            package_id: samplePkg.id,
            profile_name: 'Test_PPPoE_Profile',
            rate_limit: '10M/10M',
            only_one: 'yes'
        });
        console.log('Profile Response:', profileRes.data);

        // 3. Test PPPoE Account Provisioning
        console.log('\n[3] Testing POST /api/pppoe/accounts...');
        const accountRes = await axios.post(`${BASE_URL}/pppoe/accounts`, {
            user_id: 1, // Assumes user ID 1 exists in DB
            router_id: 1,
            package_id: samplePkg.id,
            username: 'test_client_01',
            password: 'SecurePassword999'
        });
        console.log('Account Response:', accountRes.data);

        // 4. Test Fetching Active Sessions
        console.log('\n[4] Testing GET /api/pppoe/sessions...');
        const sessionsRes = await axios.get(`${BASE_URL}/pppoe/sessions`);
        console.log('Active Sessions:', sessionsRes.data);

        console.log('\n=============================================');
        console.log('All PPPoE API tests completed successfully!');
        console.log('=============================================');
    } catch (err) {
        console.error('\n❌ Test Failed:', err.response?.data || err.message);
    }
}

runTests();