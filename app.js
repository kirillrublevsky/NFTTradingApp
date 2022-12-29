import path from "path";
import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import Web3 from 'web3';
import { OpenSeaSDK, Network } from 'opensea-js';
import HDWalletProvider from '@truffle/hdwallet-provider';
const app = express();

const __dirname = path.resolve();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Configuration
// const nodeUrl = 'https://rinkeby.infura.io/v3/91f0561cde264a9f92d45483493cdc86';
// const network = Network.Rinkeby;

const network = Network.Main;

const defaultExpirationTime = 12;
const defaultApiTimeout = 250;
const password = '';
const apiKey = '';
const redirectUrl = '/offer';
const port = 3000;
//

let currentNode;
let nodes = [];
let processedTokens = [];

let seaport;
let accountAddress;
let key;
let finished = true;

const startDate = new Date().toString();
const data = new Map();
const transactions = [];

// Express controller

app.use(bodyParser.urlencoded({
  limit: '50mb',
  extended: true
}));

app.use(express.static(__dirname + '/'))

app.get('/', function (req, res) {
  res.sendfile(__dirname + "/index.html");
});

app.post('/check', (req, res) => {
  if (req.body.password === password) {
    res.json('ok');
  } else {
    res.json('not ok');
  }
});

app.post('/flush', (req, res) => {
  checkPassword(req.body.password);
  seaport = null;
  accountAddress = null;
  key = null;
  res.redirect(redirectUrl);
});

app.post('/restart', (req, res) => {
  checkPassword(req.body.password);
  res.redirect(redirectUrl);
  console.log(`${getDate()} Application was forcefully stopped`);
  process.exit();
});

app.post('/key', (req, res) => {
  checkPassword(req.body.password);
  key = req.body.key;
  if (key) {
    updateSeaport();
  }
  console.log(`${getDate()} Private key was added`);
  res.redirect(redirectUrl);
});

app.post('/add', (req, res) => {
  checkPassword(req.body.password);
  parseBulkAddition(req.body);
  const requestData = req.body.data.trim();
  if (requestData.substring(2, 5) === "set") {
    const set = JSON.parse(requestData)['set'];
    const name = Object.keys(set)[0];
    data.set(name, set[name]);
  } else {
    let assets;
    if (requestData.startsWith("contract")) {
      assets = parseStringAssets(requestData);
    } else if (!requestData) {
      assets = [];
    } else {
      assets = parseAssets(requestData);
    }

    const existingValue = data.get(req.body.name);
    if (existingValue) {
      existingValue.assets = existingValue.assets.concat(assets);
      if (req.body.duration) {
        existingValue.duration = Number.parseInt(req.body.duration);
      }
      if (req.body.from) {
        existingValue.from = Number.parseFloat(req.body.from.replace(',', '.'));
      }
      if (req.body.to) {
        existingValue.to = Number.parseFloat(req.body.to.replace(',', '.'));
      }
      if (req.body.step) {
        existingValue.step = Number.parseFloat(req.body.step.replace(',', '.'));
      }
    } else {
      const value = {
        duration: req.body.duration ? Number.parseInt(req.body.duration)
            : defaultExpirationTime,
        from: Number.parseFloat(req.body.from.replace(',', '.')),
        to: Number.parseFloat(req.body.to.replace(',', '.')),
        step: Number.parseFloat(req.body.step.replace(',', '.')),
        assets: assets
      };
      if (req.body.name) {
        data.set(req.body.name, value);
      }
    }
  }

  writeData();
  res.redirect(redirectUrl);
});

app.get('/data', (req, res) => {
  checkPassword(req.query.password);
  const arr = [];
  const sets = {};
  for (const entry of data) {
    const name = entry[0];
    const value = entry[1];
    arr.push({
      name: name,
      duration: value.duration ? value.duration : defaultExpirationTime,
      range: `${value.from} - ${value.to}`,
      step: value.step,
      count: value.assets.length
    });
    sets[name] = value;
  }
  const response = {
    time: startDate,
    arr: arr,
    sets: sets,
    tx: transactions,
    key: !!seaport
  };
  res.json(response);
});

app.post('/remove', (req, res) => {
  checkPassword(req.body.password);
  data.delete(req.body.id);
  writeData();
  res.redirect(redirectUrl);
});

// Express helper functions

function checkPassword(pass) {
  if (pass !== password) {
    const message = `Wrong password ${pass}`;
    transactions.push(message);
    throw new Error(message);
  }
}

function parseBulkAddition(body) {
  const checked = body.all && body.all === 'on';
  if (checked || body.list) {
    if (checked) {
      for (const set of data.values()) {
        updateSet(set, body);
      }
    } else if (body.list) {
      const arr = body.list.split(',');
      for (const name of arr) {
        const existingValue = data.get(name.trim());
        if (existingValue) {
          updateSet(existingValue, body);
        }
      }
    }
  }
}

function updateSet(set, body) {
  if (body.duration) {
    set.duration = Number.parseInt(body.duration);
  }
  if (body.from) {
    set.from = Number.parseFloat(body.from.replace(',', '.'));
  }
  if (body.to) {
    set.to = Number.parseFloat(body.to.replace(',', '.'));
  }
  if (body.step) {
    set.step = Number.parseFloat(body.step.replace(',', '.'));
  }
}

function parseStringAssets(request) {
  const arr = request.split(',');
  const contractAddress = arr[0].trim().split(':')[1].trim();
  const from = arr[1].trim().split(':')[1].trim();
  const to = arr[2].trim().split(':')[1].trim();

  const assets = [];
  let start = Number.parseInt(from);
  let end = Number.parseInt(to);

  for (let i = start; i <= end; i++) {
    assets.push({
      contractAddress: contractAddress,
      tokenId: i
    });
  }
  return assets;
}

function parseAssets(request) {
  const requestData = JSON.parse(request).data;
  let edges;
  if (requestData.assets) {
    edges = requestData.assets.search.edges;
  } else {
    edges = requestData.query.search.edges;
  }
  return edges.map(e => {
    return {
      contractAddress: e.node.asset.assetContract.address,
      tokenId: e.node.asset.tokenId
    };
  });
}

// Scheduler

setInterval(async () => {
  if (seaport && finished) {

    finished = false;
    try {
      const map = await populateOrders();
      await processOrders(Array.from(map.values()));
    } catch (e) {
      const errorMessage = `${getDate()} Scheduler is unsuccessful with error message ${e}`;
      addMessageToLog(errorMessage);
      console.error(errorMessage);
    } finally {
      finished = true;
    }
  }
}, 60000);

// Scheduler helper functions

async function getSchemaName(set) {
  const tokenAddress = set.assets[0].contractAddress;
  const tokenId = set.assets[0].tokenId;

  return await getSchema({
    tokenAddress,
    tokenId
  }, defaultApiTimeout);
}

async function populateOrders() {
  const message = `${getDate()} Populating empty orders`;
  addMessageToLog(message);
  console.log(message);

  const orders = new Map();
  for (const set of data.values()) {
    let schema;
    for (const asset of set.assets) {
      const existingValue = orders.get(asset.tokenId.toString());
      if (!existingValue) {

        if (!schema) {
          schema = await getSchemaName(set);
        }

        const value = {
          tokenId: asset.tokenId,
          contractAddress: asset.contractAddress,
          duration: set.duration ? set.duration : defaultExpirationTime,
          from: set.from,
          schema: schema,
          asset: asset
        };
        orders.set(asset.tokenId.toString(), value);
      } else {
        if (set.duration > existingValue.duration) {
          existingValue.duration = set.duration;
        }
        if (set.from > existingValue.from) {
          existingValue.from = set.from;
          existingValue.lastPrice = set.from - set.step;
        }
      }
    }
  }
  return orders;
}

async function processOrders(orders) {
  const startMessage = `${getDate()} STARTING PROCESSING ORDERS`;
  addMessageToLog(startMessage);
  console.log(startMessage);

  const startTime = Math.floor(Date.now() / 1000);
  let totalCount = 0;
  let processedCount = 0;

  for (let i = 0; i < orders.length; i++) {
    totalCount++;
    const order = orders[i];
    const active = order.asset.expirationTime && order.asset.expirationTime
        > Math.floor(new Date() / 1000);
    if (active && order.asset.price === order.from) {
      if (i % 10 === 0 && i > 0) {
        updateAllSets(i);
      }
      continue;
    }
    await createOffer(order, order.from);
    processedCount++;
    if (i % 10 === 0 && i > 0) {
      updateAllSets(i);
    }
  }
  updateAllSets(orders.length);

  const endMessage = `${getDate()} ORDERS PROCESSED: ${processedCount} of ${totalCount} in ${getDuration(
      startTime)}`;
  addMessageToLog(endMessage);
  console.log(endMessage);
}

async function createOffer(order, startAmount) {
  const time = Math.floor(new Date() / 1000) + order.duration * 60 * 60;
  const buyOrder = {
    asset: {
      tokenId: order.tokenId,
      tokenAddress: order.contractAddress,
      schemaName: order.schema
    },
    accountAddress: accountAddress,
    expirationTime: time,
    startAmount: startAmount,
  };
  try {
    const offer = await createBuyOrder(buyOrder, defaultApiTimeout);
    if (!offer) {
      return;
    }
    processedTokens.push({
      contractAddress: order.contractAddress,
      tokenId: order.tokenId,
      expirationTime: time,
      price: startAmount
    });

    const message = `${getDate()} Token id ${offer.metadata.asset.id}, address ${offer.metadata.asset.address}, amount ${startAmount}`;
    addMessageToLog(message);
    console.log(message);
  } catch (e) {
    const errorMessage = `${getDate()} CreateOffer request is unsuccessful with error message ${e}`;
    addMessageToLog(errorMessage);
    console.error(errorMessage);
  }
}

// Helper functions

function getDuration(start) {
  const end = Math.floor(Date.now() / 1000);
  const minutes = Math.floor((end - start) / 60);
  const seconds = end - start - minutes * 60;
  return `${minutes} minutes and ${seconds} seconds`;
}

function addMessageToLog(message) {
  if (transactions.length >= 50) {
    transactions.shift();
  }
  transactions.push(message);
}

function getDate() {
  const date = new Date();
  const d = date.toLocaleDateString();
  const t = date.toLocaleTimeString();
  return `${d} ${t}`;
}

function writeData() {
  const sets = {};
  data.forEach((value, key, map) => sets[key] = value);

  fs.truncate('data.json', 0, () => {
    console.log(`${getDate()} Data file was cleaned`);
  });

  fs.writeFile('data.json', JSON.stringify(sets), err => {
    if (err) {
      return console.log(err);
    }
    console.log(`${getDate()} Data > data.json`);
  });
}

// Starting express

app.listen(port, () => {
  readNodes();
  readDataJson();
  console.log(`${getDate()} Application listening at http://localhost:${port}`);
});

function readNodes() {
  const file = fs.readFileSync('nodes.txt', 'utf8');
  const split = file.split('\n');
  for (const node of split) {
    if (node !== '') {
      nodes.push(node.trim());
    }
  }
  nodes.sort(() => Math.random() - 0.5);
  console.log(nodes);
  currentNode = nodes[0];
}

function readDataJson() {
  const file = fs.readFileSync('data.json', 'utf8');
  if (file.length >= 2) {
    const sets = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    for (const [key, value] of Object.entries(sets)) {
      data.set(key, value);
    }
    console.log(`${getDate()} Data restored from file`);
  }
}

// Preventing application restart

process.on('uncaughtException', function (err) {
  console.log(`${getDate()} Uncaught exception: ${err}`);
  updateSeaport();
});

// Exponential backoff

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createBuyOrder(buyOrder, timeout) {
  if (timeout > 3000) {
    throw 'Timeout exceeded 3 seconds';
  }
  await sleep(timeout);
  try {
    return await seaport.createBuyOrder(buyOrder);
  } catch (e) {
    if (e.message.includes('API Error 429')) {
      const errorMessage = `${getDate()} RETRY createBuyOrder in ${timeout
      * 2} ms: ${e.message}`;
      addMessageToLog(errorMessage);
      console.error(errorMessage);
      return await createBuyOrder(buyOrder, timeout * 2);
    } else {
      await checkInfuraLimits(e.message);
      return null;
    }
  }
}

async function getSchema(query, timeout) {
  if (timeout > 30000) {
    throw 'Timeout exceeded 30 seconds';
  }
  await sleep(timeout);
  try {
    const asset = await seaport.api.getAsset(query);
    return asset.assetContract.schemaName;
  } catch (e) {
    if (e.message.includes('API Error 429')) {
      const errorMessage = `${getDate()} RETRY getSchema in ${timeout
      * 2} ms: ${e.message}`;
      addMessageToLog(errorMessage);
      console.error(errorMessage);
      return await getSchema(query, timeout * 2);
    } else {
      await checkInfuraLimits(e.message);
      return null;
    }
  }
}

// Delete processed assets from sets

function updateAllSets(index) {
  if (processedTokens.length === 0) {
    return;
  }
  for (let [name, set] of data) {
    const assets = set.assets;
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      for (const token of processedTokens) {
        if (token.tokenId === asset.tokenId && token.contractAddress
            === asset.contractAddress) {
          asset.expirationTime = token.expirationTime;
          asset.price = token.price;
        }
      }
    }
    set.assets = assets;
    data.set(name, set);
  }
  console.log('NUMBER OF PROCESSED TOKENS: ' + processedTokens.length);
  addMessageToLog('NUMBER OF PROCESSED TOKENS: ' + processedTokens.length);
  processedTokens = [];
  writeData();
  console.log('SETS UPDATED AT ORDERS: ' + index);
  addMessageToLog('SETS UPDATED AT ORDERS: ' + index);
}

// Change Infura node

async function checkInfuraLimits(errorMessage) {
  if (errorMessage.includes(
          'daily request count exceeded, request rate limited')
      || errorMessage.includes('Invalid JSON RPC response')) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node === currentNode) {
        if (i === (nodes.length - 1)) {
          currentNode = nodes[0];
        } else {
          currentNode = nodes[i + 1];
        }
        updateSeaport();
        const message = `${getDate()} Infura node changed to ${currentNode} due to daily limits`;
        addMessageToLog(message);
        console.log(message);
        break;
      }
    }
  } else {
    throw errorMessage;
  }
}

function updateSeaport() {
  try {
    const httpProvider = new Web3.providers.HttpProvider(currentNode);
    httpProvider.sendAsync = httpProvider.send;
    const provider = new HDWalletProvider(key, httpProvider);
    seaport = new OpenSeaSDK(provider, {
      networkName: network,
      apiKey: apiKey
    });
    accountAddress = provider.getAddresses()[0];
  } catch (e) {
    transactions.push(e.message);
    console.error(e.message);
  }
}
