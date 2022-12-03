const express = require('express'); // Sử dụng framework express
const Web3 = require('web3');
const fs = require('fs');
const {
  get,
  uniq,
  merge,
  add,
  difference,
  uniqBy,
  differenceBy,
  orderBy,
} = require('lodash');
const { start } = require('repl');

const port = process.env.NODE_PORT || 5111;
const domain = '0.0.0.0';

const server = express();
server.use(express.json());

const hexToDecimal = (hex) => {
  if (!hex) return 0;

  if (!hex?.startsWith('0x')) return hex;

  return Web3.utils.hexToNumberString(hex);
};

const toChecksumAddress = (address) => {
  if (!address) return '';

  return Web3.utils.toChecksumAddress(address);
};

const convertComplementToHex = (str, isNumber = false) => {
  const strReplace = str?.replace(/0x(0)*/, '');

  if (!strReplace) return '';

  let checksumAddress;

  try {
    checksumAddress = toChecksumAddress(`0x${strReplace}`);
  } catch (error) {
    checksumAddress = `0x${strReplace}`;
  }

  return !isNumber ? checksumAddress : `0x${strReplace}`;
};

const forceUpdateNFTs = async () => {
  let logs = [];
  try {
    logs = JSON.parse(await fs.readFileSync('logs.json', 'utf8'));
  } catch (error) {}

  let objIns = {};
  let objOuts = {};

  logs.forEach((log) => {
    const sender = convertComplementToHex(get(log, 'topics.1'));
    const receipt = convertComplementToHex(get(log, 'topics.2'));
    const contract = toChecksumAddress(get(log, 'address'));

    let id = convertComplementToHex(get(log, 'topics.3'), true);
    id = hexToDecimal(id);

    if (receipt && id) {
      let arrIds = get(objIns, `${receipt}.${contract}`, []);

      arrIds = uniqBy(
        arrIds.concat({ id, blockNumber: get(log, 'blockNumber') }),
        (v) => v.id
      );

      objIns = merge({}, objIns, { [receipt]: { [contract]: arrIds } });
    }

    if (sender && id) {
      let arrIds = get(objOuts, `${sender}.${contract}`, []);

      arrIds = uniqBy(
        arrIds.concat({ id, blockNumber: get(log, 'blockNumber') }),
        (v) => v.id
      );

      objOuts = merge({}, objOuts, { [sender]: { [contract]: arrIds } });
    }
  });

  await Promise.all(
    Object.keys(objIns).map(async (address) => {
      const nfts = get(objIns, address, {});
      const outNfts = get(objOuts, address, {});

      let oldNftAddress = {};
      try {
        oldNftAddress = JSON.parse(
          fs.readFileSync(__dirname + `/nfts/${address}.json`, 'utf8')
        );
      } catch (error) {}

      const curr = merge({}, oldNftAddress, nfts);
      const contracts = Object.keys(curr);

      const newFormat = contracts.reduce((prev, contract) => {
        const result = merge({}, prev, {
          [contract]: orderBy(
            differenceBy(
              get(curr, contract, []),
              get(outNfts, contract, []),
              (v) => v.id
            ),
            (v) => v.blockNumber
          ),
        });

        return result;
      }, curr);

      fs.writeFileSync(
        __dirname + `/nfts/${address}.json`,
        JSON.stringify(newFormat, null, 4)
      );
    })
  );

  let config = { wallet: [] };

  try {
    config = JSON.parse(fs.readFileSync('configs.json', 'utf8'));
    config.wallet = uniq(config.wallet.concat(Object.keys(objIns)));

    fs.writeFileSync('configs.json', JSON.stringify(config, null, 4));
  } catch (error) {}
};

const syncFromBlock = async (topicsConfig) => {
  const STEP = 100;

  let curr = [];

  const { fromBlock, toBlock } = topicsConfig;

  const web3 = new Web3();
  web3.setProvider(
    new web3.providers.WebsocketProvider(
      'wss://maximum-silent-field.bsc.discover.quiknode.pro/3968853bc1c5dee85c1d7da2b6e8e5c1a7c4fedb/'
    )
  );

  const nextBlock = fromBlock + STEP >= toBlock ? toBlock : fromBlock + STEP;
  let logs;
  logs = await web3.eth
    .getPastLogs({
      fromBlock: fromBlock,
      toBlock: nextBlock,
      topics: [
        Web3.utils.sha3('Transfer(address,address,uint256)'),
        null,
        null,
        null,
      ],
    })
    .catch((res) => []);

  curr = curr.concat(logs);

  if (logs?.length) {
    let oldLogs = [];
    try {
      oldLogs = JSON.parse(fs.readFileSync('logs.json', 'utf8'));
      curr = oldLogs.concat(curr);
    } catch (error) {}
    await fs.writeFileSync(
      'logs.json',
      JSON.stringify(
        uniqBy(curr, (v) => v.id),
        null,
        4
      )
    );
  }

  return logs?.length;
};

server.post('/socketSync', (req, res) => {
  let lastSync = undefined;

  const start = () => {
    const web3 = new Web3();
    web3.setProvider(
      new web3.providers.WebsocketProvider(
        'wss://maximum-silent-field.bsc.discover.quiknode.pro/3968853bc1c5dee85c1d7da2b6e8e5c1a7c4fedb/'
      )
    );

    const subscribe = web3.eth.subscribe('newBlockHeaders');
    console.log({ lastSync });
    subscribe.on('data', async (data) => {
      if (typeof lastSync === 'undefined') {
        let config = { currSync: 0, lastSync: 0 };

        try {
          config = JSON.parse(fs.readFileSync('configs.json', 'utf8'));
        } catch (error) {}
        config.lastSync = data.number;
        lastSync = data.number;
        fs.writeFileSync('configs.json', JSON.stringify(config, null, 4));
      }

      const hasLogs = await syncFromBlock({
        fromBlock: data.number,
        toBlock: data.number,
      });
      !!hasLogs && (await forceUpdateNFTs());
      console.log('socket: ', { logs: hasLogs, fromBlock: data.number });
    });
  };

  start();
  return res.send({
    success: true,
  });
});

server.get('/:address', async (req, res) => {
  const { address } = req.params;

  let nfts = {};
  console.log({ address }, req.params);
  try {
    nfts = JSON.parse(
      fs.readFileSync(__dirname + `/nfts/${address}.json`, 'utf8')
    );
  } catch (error) {}

  nfts = Object.keys(nfts).reduce((prev, contract) => {
    return [
      ...prev,
      nfts[contract].map((id) => ({
        address: contract,
        ...id,
      })),
    ];
  }, []);

  return res.send({
    data: orderBy(nfts, (v) => v.blockNumber),
  });
});

server.post('/sync', (req, res) => {
  const { fromBlock } = req.body;
  let config = {};

  try {
    config = JSON.parse(fs.readFileSync('configs.json', 'utf8'));
  } catch (error) {}

  config.currSync = fromBlock || config.currSync;

  const { currSync, lastSync } = config;
  console.log({ config, fromBlock });
  const syncFunc = async () => {
    for (let idx = currSync; idx <= lastSync; idx += 100) {
      let hasLogs;
      try {
        hasLogs = await syncFromBlock({
          fromBlock: idx,
          toBlock: lastSync,
        });
        !!hasLogs && (await forceUpdateNFTs());
      } catch (error) {
        return;
      }

      console.log('sync: ', { logs: hasLogs, fromBlock: idx });

      config.currSync = idx + 100;
      fs.writeFileSync('configs.json', JSON.stringify(config, null, 4));
    }
  };
  syncFunc();
  return res.send({ success: true });
});

server.listen(port, async (err) => {
  if (err) throw err;

  console.log(`> Ready on http://${domain}:${port}`);
});
