const fs = require("fs");

const SNAX_STORE_HASH = process.env.SNAX_STORE_HASH;
const SNAX_TOKEN = process.env.SNAX_TOKEN;

const BESTBUDS_STORE_HASH = process.env.BESTBUDS_STORE_HASH;
const BESTBUDS_TOKEN = process.env.BESTBUDS_TOKEN;

// Only sync these products
const PREFIX = "SX-";
const MAX_ORDERS = 50;

function logMessage(message) {
  const line = `${new Date().toISOString()} - ${message}`;
  console.log(line);
  fs.appendFileSync("sync-log.txt", line + "\n");
}

function getProcessedOrders() {
  // Temporary cloud-safe version
  return new Set();
}

function markOrderProcessed(orderId) {
  // Temporary cloud-safe version
}

async function fetchSnaxProducts() {
  const url = `https://api.bigcommerce.com/stores/${SNAX_STORE_HASH}/v3/catalog/products?limit=250`;

  const res = await fetch(url, {
    headers: {
      "X-Auth-Token": SNAX_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch SNAX products: ${res.status} ${res.statusText} - ${errorText}`);
  }

  const data = await res.json();

  if (!data || !Array.isArray(data.data)) {
    throw new Error(`Unexpected SNAX response: ${JSON.stringify(data)}`);
  }

  return data.data;
}

async function fetchBestBudsProducts() {
  let allProducts = [];
  let page = 1;
  let keepGoing = true;

  while (keepGoing) {
    const res = await fetch(
      `https://api.bigcommerce.com/stores/${BESTBUDS_STORE_HASH}/v3/catalog/products?limit=250&page=${page}`,
      {
        headers: {
          "X-Auth-Token": BESTBUDS_TOKEN,
          "Content-Type": "application/json",
          "Accept": "application/json"
        }
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to fetch Best Buds products page ${page}: ${res.status} ${res.statusText} - ${errorText}`);
    }

    const data = await res.json();
    const products = data.data || [];

    allProducts = allProducts.concat(products);

    if (products.length < 250) {
      keepGoing = false;
    } else {
      page++;
    }
  }

  return allProducts;
}

async function fetchRecentBestBudsOrders() {
  const res = await fetch(
    `https://api.bigcommerce.com/stores/${BESTBUDS_STORE_HASH}/v2/orders?limit=${MAX_ORDERS}&sort=date_created:desc`,
    {
      headers: {
        "X-Auth-Token": BESTBUDS_TOKEN,
        "Accept": "application/json"
      }
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch recent Best Buds orders: ${res.status} ${res.statusText} - ${errorText}`);
  }

  const data = await res.json();
  return data || [];
}

async function fetchOrderProducts(orderId) {
  const res = await fetch(
    `https://api.bigcommerce.com/stores/${BESTBUDS_STORE_HASH}/v2/orders/${orderId}/products`,
    {
      headers: {
        "X-Auth-Token": BESTBUDS_TOKEN,
        "Accept": "application/json"
      }
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch products for order ${orderId}: ${res.status} ${res.statusText} - ${errorText}`);
  }

  const data = await res.json();
  return data || [];
}

async function updateBestBudsInventory(productId, inventory) {
  const res = await fetch(
    `https://api.bigcommerce.com/stores/${BESTBUDS_STORE_HASH}/v3/catalog/products/${productId}`,
    {
      method: "PUT",
      headers: {
        "X-Auth-Token": BESTBUDS_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        inventory_level: inventory
      })
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    logMessage(`FAILED updating Best Buds product ${productId}: ${errorText}`);
    return false;
  }

  return true;
}

async function updateSnaxInventory(productId, inventory) {
  const res = await fetch(
    `https://api.bigcommerce.com/stores/${SNAX_STORE_HASH}/v3/catalog/products/${productId}`,
    {
      method: "PUT",
      headers: {
        "X-Auth-Token": SNAX_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        inventory_level: inventory
      })
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    logMessage(`FAILED updating SNAX product ${productId}: ${errorText}`);
    return false;
  }

  return true;
}

async function processOrders(snaxProducts) {
  const recentOrders = await fetchRecentBestBudsOrders();
  const processedOrders = getProcessedOrders();

  logMessage(`Loaded ${recentOrders.length} recent Best Buds orders`);
  logMessage(`Loaded ${processedOrders.size} previously processed orders`);

  for (const order of recentOrders) {
    const orderId = String(order.id);

    if (processedOrders.has(orderId)) {
      logMessage(`Skipping already processed order ${orderId}`);
      continue;
    }

    logMessage(`Checking Order ID: ${orderId}`);
    const orderProducts = await fetchOrderProducts(order.id);

    let foundAnySXItem = false;
    let orderProcessedSuccessfully = true;

    for (const item of orderProducts) {
      const sku = item.sku;
      const quantity = Number(item.quantity) || 0;

      if (!sku || !sku.startsWith(PREFIX)) {
        continue;
      }

      foundAnySXItem = true;
      logMessage(`Found SX product in order ${orderId}: ${sku} (qty: ${quantity})`);

      const snaxMatch = snaxProducts.find(p => p.sku === sku);

      if (!snaxMatch) {
        logMessage(`No matching SNAX product found for ordered SKU ${sku}`);
        orderProcessedSuccessfully = false;
        continue;
      }

      const currentInventory = Number(snaxMatch.inventory_level) || 0;
      const newInventory = Math.max(0, currentInventory - quantity);

      logMessage(`Reducing SNAX inventory for ${sku}: ${currentInventory} -> ${newInventory}`);

      const success = await updateSnaxInventory(snaxMatch.id, newInventory);

      if (success) {
        snaxMatch.inventory_level = newInventory;
        logMessage(`Reduced SNAX inventory for ${sku} successfully`);
      } else {
        orderProcessedSuccessfully = false;
      }
    }

    if (foundAnySXItem && orderProcessedSuccessfully) {
      markOrderProcessed(orderId);
      logMessage(`Marked order ${orderId} as processed`);
    } else if (!foundAnySXItem) {
      logMessage(`No SX items found in order ${orderId}`);
      markOrderProcessed(orderId);
      logMessage(`Marked non-SX order ${orderId} as processed`);
    } else {
      logMessage(`Order ${orderId} was NOT marked processed due to errors`);
    }
  }
}

async function syncSnaxToBestBuds(snaxProducts, bestBudsProducts) {
  for (const snaxProduct of snaxProducts) {
    const sku = snaxProduct.sku;

    if (!sku || !sku.startsWith(PREFIX)) continue;

    const match = bestBudsProducts.find(p => p.sku === sku);

    if (!match) {
      logMessage(`No match found for ${sku}`);
      continue;
    }

    const snaxInventory = Number(snaxProduct.inventory_level) || 0;
    const bestBudsInventory = Number(match.inventory_level) || 0;

    if (snaxInventory === bestBudsInventory) {
      logMessage(`Skipping ${sku} - already matches at ${snaxInventory}`);
      continue;
    }

    logMessage(`Updating ${sku} - Best Buds: ${bestBudsInventory} -> SNAX: ${snaxInventory}`);

    const success = await updateBestBudsInventory(match.id, snaxInventory);

    if (success) {
      logMessage(`Updated ${sku} successfully`);
    }
  }
}

async function runSync() {
  logMessage("Starting sync...");

  const snaxProducts = await fetchSnaxProducts();
  const bestBudsProducts = await fetchBestBudsProducts();

  logMessage(`Loaded ${snaxProducts.length} SNAX products`);
  logMessage(`Loaded ${bestBudsProducts.length} Best Buds products`);

  await processOrders(snaxProducts);
  await syncSnaxToBestBuds(snaxProducts, bestBudsProducts);

  logMessage("Sync complete.");
}

runSync().catch(err => {
  logMessage(`Sync failed: ${err.message}`);
});
