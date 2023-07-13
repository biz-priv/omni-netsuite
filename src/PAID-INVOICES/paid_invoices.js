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

const source_system = "OL";
const today = moment().format("DD/MM/yyyy");
const fromDate = moment().subtract(3, "d").format("DD/MM/yyyy");
const toDate = today;
const createdDate= moment().format("YYYY-MM-DD HH:mm:ss");

// const fromDate = "07/01/2023";
// const toDate = "07/01/2023";
// 05/01/2022
//05/02/2022

module.exports.handler = async (event, context, callback) => {
  try {
    /**
     * Get connections
     */
    userConfig = getConfig(source_system, process.env);
    connections = await getConnectionToRds(process.env);
    const data = await getPaidInvoiceData();
    console.log("data", data.length);

    const perLoop = 100;
    for (let index = 0; index < (data.length + 1) / perLoop; index++) {
      let newArray = data.slice(index * perLoop, index * perLoop + perLoop);
      await Promise.all(
        newArray.map(async (item) => {
          return await insertToDB({ ...item, created_at: createdDate });
        })
      );
      console.log("exectuted", perLoop, perLoop * (index + 1));
    }
    return "Success"
  } catch (error) {
    console.log("error", error);
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
        url: `https://1238234.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=724&deploy=1&custscript_mfc_date_from=${fromDate}&custscript_mfc_date_to=${toDate}`,
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
      console.log("configApi", configApi);

      axios
        .request(configApi)
        .then((response) => {
          console.log("response", response.status);

          if (response.status === 200 && response.data.length > 0) {
            console.log("length", response.data.length);
            resolve(response.data);
          } else {
            console.log("error");
            reject({
              customError: true,
              msg: response.data.reason.replace(/'/g, "`"),
              response: JSON.stringify(response.data).replace(/'/g, "`"),
            });
          }
        })
        .catch((error) => {
          console.log(error);
          reject({
            customError: true,
            msg: error.response.data.reason.replace(/'/g, "`"),
            response: JSON.stringify(error.response.data).replace(/'/g, "`"),
          });
        });
    } catch (error) {
      console.log("error:createInvoice:main:catch", error);
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
    console.log(item);
    const itemData = item;
    const formatData= {
      internal_id: itemData.internalid,
      type: itemData.type,
      date_created: itemData.datecreated,
      transaction_no: itemData.tranid,
      amount: itemData.amount,
      company_name: itemData.custbody_riv_entity_cpnyname.replace(/'/g, "`"),
      shipment: itemData.custbody9,
      due_date: itemData.duedate,
      source_system: itemData.custbody_source_system,
      paying_transaction: itemData.payingtransaction,
      amount_remaining: itemData.amountremaining,
      load_create_date: itemData.created_at
    }

    // console.log("formatData", JSON.stringify(formatData));

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

    console.log("tableStr", tableStr);
    console.log("valueStr", valueStr);
    console.log("updateStr", updateStr);
    
    const keyValuePairs = updateStr.split(',');
    const filteredKeyValuePairs = keyValuePairs.filter(pair => !pair.includes('internal_id'));
    const updatedUpdateStr = filteredKeyValuePairs.join(',');
    // const upsertQuery = `INSERT INTO dw_uat.netsuit_paid_invoices (${tableStr})
    //                     VALUES (${valueStr});`;
    const upsertQuery = `INSERT INTO dw_uat.netsuit_paid_invoices (${tableStr})
                        VALUES (${valueStr}) ON DUPLICATE KEY
                        UPDATE ${updatedUpdateStr};`;
    console.log("upsertQuery",upsertQuery);
    await connections.execute(upsertQuery);
  } catch (error) {
    console.log("error", error);
  }
}
