const AWS = require("aws-sdk");
const axios = require("axios");
const {
  getConfig,
  getConnectionToRds,
  getAuthorizationHeader,
} = require("../../Helpers/helper");
const moment = require("moment");

let userConfig = "";
let connections = "";

const dbname = process.env.DATABASE_NAME;
const source_system = "OL";
const today = moment().format("MM/DD/yyyy");
const fromDate = moment().subtract(3, "d").format("MM/DD/yyyy");
const toDate = today;
const createdDate= moment().format("YYYY-MM-DD HH:mm:ss");


module.exports.handler = async (event, context, callback) => {
  try {
    /**
     * Get connections
     */
    userConfig = getConfig(source_system, process.env);
    connections = await getConnectionToRds(process.env);
    const data = await getPaidInvoiceData();
    console.info("data", data.length);

    const perLoop = 100;
    for (let index = 0; index < (data.length + 1) / perLoop; index++) {
      let newArray = data.slice(index * perLoop, index * perLoop + perLoop);
      await Promise.all(
        newArray.map(async (item) => {
          return await insertToDB({ ...item, created_at: createdDate });
        })
      );
      console.info("exectuted", perLoop, perLoop * (index + 1));
    }
    return "Success"
  } catch (error) {
    console.error("error", error);
  }
};

function getPaidInvoiceData() {
  return new Promise((resolve, reject) => {
    try {
      const options = {
        consumer_key: userConfig.token.consumer_key,
        consumer_secret_key: userConfig.token.consumer_secret,
        token: userConfig.token.token_key,
        token_secret: userConfig.token.token_secret,
        realm: userConfig.account,
        url: `${process.env.NETSUIT_BASE_URL}/app/site/hosting/restlet.nl?script=724&deploy=1&custscript_mfc_date_from=${fromDate}&custscript_mfc_date_to=${toDate}`,
        method: "GET",
      };
      const authHeader = getAuthorizationHeader(options);

      const configApi = {
        method: options.method,
        maxBodyLength: Infinity,
        url: options.url,
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
      };

      axios
        .request(configApi)
        .then((response) => {
          console.info("response", response.status);

          if (response.status === 200 && response.data.length > 0) {
            console.info("length", response.data.length);
            resolve(response.data);
          } else {
            console.error("error");
            reject({
              customError: true,
              msg: response.data.reason.replace(/'/g, "`"),
              response: JSON.stringify(response.data).replace(/'/g, "`"),
            });
          }
        })
        .catch((error) => {
          console.error(error);
          reject({
            customError: true,
            msg: error.response.data.reason.replace(/'/g, "`"),
            response: JSON.stringify(error.response.data).replace(/'/g, "`"),
          });
        });
    } catch (error) {
      console.error("error:createInvoice:main:catch", error);
      reject({
        customError: true,
        msg: "Netsuit paid invoice Api Failed",
        response: "",
      });
    }
  });
}

async function insertToDB(item) {
  try {
    const itemData = item;
    const formatData= {
      internal_id: itemData.internalid,
      type: itemData.type,
      date_created: moment(itemData.datecreated,'MM/DD/YYYY hh:mm a').format('YYYY-MM-DD HH:mm:ss'),
      transaction_no: itemData.tranid,
      amount: itemData.amount,
      company_name: itemData.custbody_riv_entity_cpnyname.replace(/'/g, "`"),
      shipment: itemData.custbody9,
      due_date: moment(itemData.duedate,'MM/DD/YYYY').format('YYYY-MM-DD'),
      source_system: itemData.custbody_source_system,
      paying_transaction: itemData.payingtransaction,
      amount_remaining: itemData.amountremaining,
      load_create_date: itemData.created_at,
      load_update_date :itemData.created_at,
    }


    let tableStr = "";
    let valueStr = "";
    let updateStr = "";

    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
        updateStr += e != "customer_id" ? "," : "";
      }
      if (e != "customer_id") {
        updateStr += e + "='" + formatData[e] + "'";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");
    
    const keyValuePairs = updateStr.split(',');
    const filteredKeyValuePairs = keyValuePairs.filter(pair => !pair.includes('internal_id') & !pair.includes('load_create_date') );
    const updatedUpdateStr = filteredKeyValuePairs.join(',');
  
    const upsertQuery = `INSERT INTO ${dbname}netsuit_paid_invoices (${tableStr})
                        VALUES (${valueStr}) ON DUPLICATE KEY
                        UPDATE ${updatedUpdateStr};`;
    // console.info("upsertQuery",upsertQuery);
    await connections.execute(upsertQuery);
  } catch (error) {
    console.error("error", error);
  }
}
