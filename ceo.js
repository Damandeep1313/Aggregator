require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { ethers } = require("ethers");
// For concurrency-limited swaps
const pLimit = require("p-limit"); // v2.3.0 ensures CommonJS compatibility

// ---------------------- CONFIG & CONSTANTS ------------------------
const chainId = 1; // Ethereum mainnet
// 1inch dev aggregator base (v6)
const aggregatorBase = `https://api.1inch.dev/swap/v6.0/${chainId}`;
const API_KEY = process.env.API_KEY;

const provider = new ethers.providers.JsonRpcProvider(process.env.INFURA_URL);
// The wallet used for swapping
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// 1inch dev aggregator spender address for Ethereum
const oneInchRouter = "0x111111125421ca6dc452d289314280a0f8842a65";

// Minimal ERC-20 ABI (to read decimals, symbol, allowance, approve)
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// In-memory array for active swap orders
const activeOrders = [];
// Concurrency limit for swap orders
const limit = pLimit(2);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------- UTILITY FUNCTIONS ------------------------
/**
 * Fetch token decimals + symbol from on-chain, or default if 0xEeee...
 */
async function fetchTokenData(tokenAddress) {
  // If it's ETH placeholder
  if (!tokenAddress || tokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    return {
      symbol: "ETH",
      decimals: 18
    };
  }
  // Otherwise, call on-chain
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([
    contract.decimals(),
    contract.symbol()
  ]);
  return { symbol, decimals };
}

/**
 * 1) Convert user-friendly amount => wei
 * 2) Check allowance (if fromToken != ETH), do approve if needed
 * 3) Call 1inch aggregator /swap
 * 4) Broadcast transaction
 */
async function processOrder(order) {
  const { fromToken, toToken, amountHuman } = order;

  // (A) fetch 'fromToken' decimals/symbol if not provided
  let fromData;
  if (order.fromDecimals && order.fromSymbol) {
    fromData = { decimals: order.fromDecimals, symbol: order.fromSymbol };
  } else {
    fromData = await fetchTokenData(fromToken);
  }
  // (B) fetch 'toToken' decimals/symbol for logging
  const toData = await fetchTokenData(toToken);

  // parse user-friendly amount to BN
  const amountWei = ethers.utils.parseUnits(amountHuman, fromData.decimals);

  console.log(`\n[PROCESS] Swapping ${amountHuman} ${fromData.symbol}(${fromToken}) => ${toData.symbol}(${toToken})`);

  // (C) If fromToken != ETH, check + approve if needed
  if (fromToken.toLowerCase() !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    const contract = new ethers.Contract(fromToken, ERC20_ABI, wallet);
    const currentAllowance = await contract.allowance(wallet.address, oneInchRouter);

    if (currentAllowance.lt(amountWei)) {
      console.log(`[ALLOWANCE] Not enough for ${fromData.symbol}. Approving...`);
      const MAX_UINT = ethers.constants.MaxUint256;
      const txApprove = await contract.approve(oneInchRouter, MAX_UINT);
      console.log(`[ALLOWANCE] Approve TX: ${txApprove.hash}, awaiting confirmation...`);
      await txApprove.wait();
      console.log(`[ALLOWANCE] Approved for ${fromData.symbol}.`);
    } else {
      console.log(`[ALLOWANCE] Sufficient for ${fromData.symbol}.`);
    }
  }

  // (D) Build aggregator /swap call
  // We set slippage=5, fee=0, from=..., origin=...
  const slippage = 5;
  const fee = 0;
  const fromAddress = wallet.address;
  const originAddress = wallet.address;

  const swapUrl = `${aggregatorBase}/swap?` +
    `src=${fromToken}&dst=${toToken}&amount=${amountWei.toString()}` +
    `&from=${fromAddress}&origin=${originAddress}&slippage=${slippage}&fee=${fee}`;

  // (E) Call aggregator, handle rate-limit
  let swapRes;
  try {
    swapRes = await axios.get(swapUrl, {
      headers: { Authorization: API_KEY },
    });
  } catch (err) {
    const errData = err.response?.data || {};
    const errMsg = errData.error || errData.description || err.message;
    if (errMsg.includes("limit of requests per second")) {
      console.log("[RATE LIMIT] Wait 3s, retry once...");
      await sleep(3000);
      swapRes = await axios.get(swapUrl, { headers: { Authorization: API_KEY } });
    } else {
      throw new Error(`Swap from ${fromData.symbol} to ${toData.symbol} failed: ${errMsg}`);
    }
  }

  const txData = swapRes.data.tx;
  console.log(`[SWAP] Broadcasting swap for ${fromData.symbol} => ${toData.symbol}...`);

  // (F) Sign + broadcast
  const txSend = await wallet.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: txData.value ? ethers.BigNumber.from(txData.value) : 0,
    gasLimit: txData.gas,
    gasPrice: txData.gasPrice ? ethers.BigNumber.from(txData.gasPrice) : undefined,
  });

  console.log(`[SWAP] TX sent: ${txSend.hash}. Waiting confirmation...`);
  const receipt = await txSend.wait();
  console.log(`[SWAP] Confirmed! Hash: ${receipt.transactionHash}`);

  return {
    success: true,
    hash: receipt.transactionHash,
    fromSymbol: fromData.symbol,
    toSymbol: toData.symbol
  };
}

// ---------------------- EXPRESS APP ------------------------
const app = express();
app.use(express.json());

/**
 * (1) POST /quote
 * Returns a quote for how many tokens you'd receive. 
 */
app.post("/quote", async (req, res) => {
  try {
    const { src, dst, amount, includeProtocols } = req.body;
    if (!src || !dst || !amount) {
      return res.status(400).json({
        error: "Missing required fields: src, dst, amount",
      });
    }

    // A) fetch decimals/symbol for src/dst
    const [srcData, dstData] = await Promise.all([
      fetchTokenData(src),
      fetchTokenData(dst),
    ]);

    const { decimals: srcDecimals, symbol: srcSymbol } = srcData;
    const { decimals: dstDecimals, symbol: dstSymbol } = dstData;

    // B) Convert user-friendly "amount" to base units
    const amountInBaseUnits = ethers.utils.parseUnits(amount, srcDecimals).toString();

    // aggregator /quote URL
    const quoteUrl = `${aggregatorBase}/quote`; 
    const config = {
      headers: {
        Authorization: API_KEY,
      },
      params: {
        src,
        dst,
        amount: amountInBaseUnits,
        fee: "1",
        gasPrice: "1",
        complexityLevel: "1",
        includeTokensInfo: "false",
        includeProtocols: includeProtocols ? "true" : "false",
        includeGas: "false",
      },
      paramsSerializer: {
        indexes: null,
      },
    };

    // C) Call aggregator
    const quoteRes = await axios.get(quoteUrl, config);
    const { dstAmount, protocols } = quoteRes.data;

    // D) Format the output
    const dstAmountReadable = ethers.utils.formatUnits(dstAmount, dstDecimals);
    const resultMessage = `You would get ~${dstAmountReadable} of ${dstSymbol}(${dst}) for ${amount} of ${srcSymbol}(${src}).`;

    let responsePayload = {
      message: resultMessage,
      dstAmountReadable,
    };
    if (includeProtocols && protocols) {
      responsePayload.protocols = protocols;
    }

    return res.json(responsePayload);
  } catch (error) {
    console.error("Error in /quote:", error);
    if (error.response && error.response.data) {
      return res.status(500).json({ error: error.response.data });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * (2) POST /placeOrders
 * Accept multiple orders, concurrency-limited swaps
 */
app.post("/placeOrders", async (req, res) => {
  try {
    const { orders } = req.body;
    if (!orders || !Array.isArray(orders)) {
      return res.status(400).json({ error: "Missing or invalid 'orders' array" });
    }

    // push new orders
    for (const o of orders) {
      o.id = Math.floor(Math.random() * 1e9).toString();
      activeOrders.push(o);
    }
    console.log(`[INFO] Received ${orders.length} new orders. total: ${activeOrders.length} in memory.`);

    // concurrency-limited processing
    const tasks = orders.map((order) =>
      limit(async () => {
        const orderId = order.id;
        console.log(`[START] Order #${orderId} => ${order.fromToken} -> ${order.toToken}`);
        try {
          const result = await processOrder(order);
          // remove from array
          const idx = activeOrders.findIndex((x) => x.id === orderId);
          if (idx !== -1) activeOrders.splice(idx, 1);

          console.log(`[SUCCESS] Order #${orderId}: swapped ${order.amountHuman} ${result.fromSymbol} => ${result.toSymbol} (TX hash: ${result.hash})`);
        } catch (err) {
          const idx = activeOrders.findIndex((x) => x.id === orderId);
          if (idx !== -1) activeOrders.splice(idx, 1);

          console.log(`[FAIL] Order #${orderId}: ${err.message}`);
        }
      })
    );

    await Promise.all(tasks);

    return res.json({
      message: "All new orders processed or queued.",
      activeOrdersCount: activeOrders.length
    });
  } catch (err) {
    console.error("Error in /placeOrders:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
