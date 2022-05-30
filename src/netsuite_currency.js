const pgp = require("pg-promise");
const { Record } = require("node-suitetalk");
const NetSuite = require("node-suitetalk");
const Configuration = NetSuite.Configuration;
const Service = NetSuite.Service;

const userConfig = {
  account: process.env.NETSUIT_AR_ACCOUNT,
  apiVersion: "2021_2",
  accountSpecificUrl: true,
  token: {
    consumer_key: process.env.NETSUIT_AR_CONSUMER_KEY,
    consumer_secret: process.env.NETSUIT_AR_CONSUMER_SECRET,
    token_key: process.env.NETSUIT_AR_TOKEN_KEY,
    token_secret: process.env.NETSUIT_AR_TOKEN_SECRET,
  },
  wsdlPath: process.env.NETSUIT_AR_WDSLPATH,
};

module.exports.handler = async (event, context, callback) => {
  try {
    /**
     * Get connections
     */
    let internalId = 1;
    const connections = getConnection();
    const lastCreatedCurrency = await getCurrencyData(connections);

    if (lastCreatedCurrency && lastCreatedCurrency.length > 0) {
      internalId = lastCreatedCurrency.currency_internal_id + 1;
    }
    await loadCurrency(connections, internalId);
    return "completed";
  } catch (error) {
    return "Failed";
  }
};

async function loadCurrency(connections, internalId) {
  const currData = await getCurrency(internalId);
  if (currData != null) {
    await createCurrencyData(connections, currData);
    await loadCurrency(connections, internalId + 1);
  }
}

function getConnection() {
  try {
    const dbUser = process.env.USER;
    const dbPassword = process.env.PASS;
    const dbHost = process.env.HOST;
    // const dbHost = "omni-dw-prod.cnimhrgrtodg.us-east-1.redshift.amazonaws.com";
    const dbPort = process.env.PORT;
    const dbName = process.env.DBNAME;

    const dbc = pgp({ capSQL: true });
    const connectionString = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;
    return dbc(connectionString);
  } catch (error) {
    throw "DB Connection Error";
  }
}

async function getCurrencyData(connections) {
  try {
    const query = `select currency_internal_id from netsuite_currency order by currency_internal_id desc limit 1`;

    const result = await connections.query(query);
    return result;
  } catch (error) {
    throw "No data found.";
  }
}

async function createCurrencyData(connections, data) {
  try {
    const query = `INSERT INTO netsuite_currency
    (currency_internal_id, curr_name, curr_symbol)
    VALUES ('${data.currency_internal_id}', '${data.curr_name}', '${data.curr_symbol}');`;
    await connections.query(query);
  } catch (error) {
    throw "Failed to Insert";
  }
}

async function getCurrency(internalId) {
  return new Promise((resolve, reject) => {
    try {
      const config = new Configuration(userConfig);
      const service = new Service(config);
      service
        .init()
        .then((/*client*/) => {
          const recordRef = new Record.Types.RecordRef();
          recordRef.internalId = internalId;
          recordRef.type = "currency";

          return service.get(recordRef);
        })
        .then((result, raw, soapHeader) => {
          if (result && result.readResponse.status["$attributes"].isSuccess) {
            const record = result.readResponse.record;
            resolve({
              currency_internal_id: record["$attributes"].internalId,
              curr_name: record.name,
              curr_symbol: record.symbol,
            });
          } else {
            resolve(null);
          }
        })
        .catch(function (err) {
          console.log("no new currency code");
          resolve(null);
        });
    } catch (error) {
      resolve(null);
    }
  });
}
