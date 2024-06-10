const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const router = express.Router();

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;


// this one store discount configuration
const discountConfigurations = [];

const verifyShopifyWebhook = (req, res, buf, encoding) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(buf, encoding)
    .digest('base64');
  if (generatedHash !== hmac) {
    res.status(401).send('Unauthorized');
  }
};

// this one is  discount configurations
router.get('/', (req, res) => {
  res.render('discounts', { discountConfigurations });
});

//this one discount configurations and create discount on Shopify
router.post('/create', async (req, res) => {
  const { discountType, value, minimumAmount, maximumAmount, collections, products } = req.body;
  const discountConfig = { id: crypto.randomBytes(16).toString('hex'), discountType, value, minimumAmount, maximumAmount, collections, products };

  try {
    const accessToken = req.app.get('accessToken');
    const shop = req.app.get('shop');
    const response = await createShopifyDiscount(discountConfig, shop, accessToken);

    discountConfig.shopifyDiscountId = response.data.price_rule.id;
    discountConfigurations.push(discountConfig);

    res.status(201).json({ message: 'Discount configuration saved', discountConfig });
  } catch (error) {
    console.error('Error creating discount:', error);
    res.status(500).send('Error creating discount');
  }
});

// this one update discount on Shopify
router.put('/update/:id', async (req, res) => {
  const { id } = req.params;
  const { discountType, value, minimumAmount, maximumAmount, collections, products } = req.body;
  const index = discountConfigurations.findIndex(config => config.id === id);
  if (index !== -1) {
    const updatedConfig = { id, discountType, value, minimumAmount, maximumAmount, collections, products, shopifyDiscountId: discountConfigurations[index].shopifyDiscountId };

    try {
      const accessToken = req.app.get('accessToken');
      const shop = req.app.get('shop');
      await updateShopifyDiscount(updatedConfig, shop, accessToken);

      discountConfigurations[index] = updatedConfig;
      res.status(200).json({ message: 'Discount configuration updated', discountConfig: updatedConfig });
    } catch (error) {
      console.error('Error updating discount:', error);
      res.status(500).send('Error updating discount');
    }
  } else {
    res.status(404).json({ message: 'Discount configuration not found' });
  }
});

// thjdelete discount  and delete discount on Shopify
router.delete('/delete/:id', async (req, res) => {
  const { id } = req.params;
  const index = discountConfigurations.findIndex(config => config.id === id);
  if (index !== -1) {
    try {
      const accessToken = req.app.get('accessToken');
      const shop = req.app.get('shop');
      await deleteShopifyDiscount(discountConfigurations[index].shopifyDiscountId, shop, accessToken);

      discountConfigurations.splice(index, 1);
      res.status(200).json({ message: 'Discount configuration deleted' });
    } catch (error) {
      console.error('Error deleting discount:', error);
      res.status(500).send('Error deleting discount');
    }
  } else {
    res.status(404).json({ message: 'Discount configuration not found' });
  }
});

// Webhook to handle orders creation
router.post('/webhook/orders/create', express.raw({ type: 'application/json', verify: verifyShopifyWebhook }), async (req, res) => {
  const order = JSON.parse(req.body);
  const accessToken = req.app.get('accessToken');
  const shop = req.app.get('shop');

  const { total_price, line_items } = order;

  const discountConfig = discountConfigurations.find(config => {
    const meetsMinAmount = total_price >= config.minimumAmount;
    const meetsMaxAmount = !config.maximumAmount || total_price <= config.maximumAmount;
    const collectionsMatch = config.collections.length === 0 || line_items.some(item => config.collections.includes(item.product_id));
    const productsMatch = config.products.length === 0 || line_items.some(item => config.products.includes(item.product_id));
    return meetsMinAmount && meetsMaxAmount && collectionsMatch && productsMatch;
  });

  if (discountConfig) {
    try {
      await applyDiscount(order, accessToken, shop, discountConfig);
      res.status(200).send('Discount applied and webhook received');
    } catch (error) {
      console.error('Error applying discount:', error);
      res.status(500).send('Error applying discount');
    }
  } else {
    res.status(200).send('No discount criteria met');
  }
});

const applyDiscount = async (order, accessToken, shop, discountConfig) => {
  const discountCode = 'AUTODISCOUNT';
  const url = `https://${shop}/admin/api/2024-04/orders/${order.id}.json`;

  const discount = discountConfig.discountType === 'fixed_amount'
    ? { code: discountCode, amount: discountConfig.value, type: 'fixed_amount' }
    : { code: discountCode, amount: discountConfig.value, type: 'percentage' };

  const response = await axios({
    method: 'put',
    url: url,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    data: {
      order: {
        id: order.id,
        discount_codes: [discount],
      },
    },
  });

  return response.data;
};

const createShopifyDiscount = async (discountConfig, shop, accessToken) => {
  const url = `https://${shop}/admin/api/2024-04/price_rules.json`;

  const priceRule = {
    price_rule: {
      title: `Discount_${discountConfig.id}`,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: discountConfig.discountType === 'fixed_amount' ? 'fixed_amount' : 'percentage',
      value: discountConfig.value * -1,
      customer_selection: 'all',
      starts_at: new Date().toISOString(),
    },
  };

  return axios({
    method: 'post',
    url: url,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    data: priceRule,
  });
};

const updateShopifyDiscount = async (discountConfig, shop, accessToken) => {
  const url = `https://${shop}/admin/api/2024-04/price_rules/${discountConfig.shopifyDiscountId}.json`;

  const priceRule = {
    price_rule: {
      value_type: discountConfig.discountType === 'fixed_amount' ? 'fixed_amount' : 'percentage',
      value: discountConfig.value * -1,
    },
  };

  return axios({
    method: 'put',
    url: url,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    data: priceRule,
  });
};

const deleteShopifyDiscount = async (shopifyDiscountId, shop, accessToken) => {
  const url = `https://${shop}/admin/api/2024-04/price_rules/${shopifyDiscountId}.json`;

  return axios({
    method: 'delete',
    url: url,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });
};

module.exports = router;
