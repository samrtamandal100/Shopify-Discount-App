const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');
const router = express.Router();

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_SCOPES = 'write_discounts,write_orders';

const APP_URL = 'https://quickstart-dcd10f9a.myshopify.com';

router.get('/shopify', (req, res) => {
    const shop = req.query.shop;
    if (!shop) {
        return res.status(400).send('Missing shop parameter.');
    }

    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `${APP_URL}/auth/shopify/callback`;
    const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&state=${state}&redirect_uri=${redirectUri}`;

    res.cookie('state', state);
    res.redirect(installUrl);
});

router.get('/shopify/callback', async (req, res) => {
    const { shop, hmac, code, state } = req.query;
    const stateCookie = req.cookies.state;

    if (state !== stateCookie) {
        return res.status(400).send('Request cannot be verified.');
    }

    const map = { ...req.query };
    delete map['signature'];
    delete map['hmac'];
    const message = querystring.stringify(map);
    const generatedHash = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(generatedHash, 'utf-8'), Buffer.from(hmac, 'utf-8'))) {
        return res.status(400).send('HMAC validation failed.');
    }

    const accessTokenUrl = `https://${shop}/admin/oauth/access_token`;
    const accessTokenPayload = {
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
    };

    try {
        const response = await axios.post(accessTokenUrl, accessTokenPayload);
        const accessToken = response.data.access_token;

        req.app.set('accessToken', accessToken);
        req.app.set('shop', shop);

        await registerWebhook(shop, accessToken);

        res.redirect('/discount');
    } catch (error) {
        console.error('Error requesting access token', error);
        res.status(500).send('Error code for access token.');
    }
});

async function registerWebhook(shop, accessToken) {
    const webhookUrl = `https://${shop}/admin/api/2023-04/webhooks.json`;
    const webhookData = {
        webhook: {
            topic: 'orders/create',
            address: `${APP_URL}/webhook/orders/create`,
            format: 'json',
        },
    };

    try {
        const response = await axios.post(webhookUrl, webhookData, {
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json',
            },
        });

        if (response.status === 201) {
            console.log('Webhook registered successfully');
        } else {
            console.log('Failed to register webhook', response.data);
        }
    } catch (error) {
        console.error('Error registering webhook', error);
    }
}

module.exports = router;
