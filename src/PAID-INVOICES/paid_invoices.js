const AWS = require("aws-sdk");
const axios = require("axios");
const {
  getConfig,
  getCustomDate,
  getConnectionToRds,
  getAuthorizationHeader,
} = require("../../Helpers/helper");
const moment = require("moment");

let userConfig = "";
let connections = "";

const source_system = "OL";
const today = moment().format("DD/MM/yyyy");
// const fromDate = moment().subtract(30, "d").format("DD/MM/yyyy");
// const toDate = today;

const fromDate = "06/21/2023";
const toDate = "06/22/2023";
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
          return await insertToDB({ ...item, created_at: today });
        })
      );
      console.log("exectuted", perLoop, perLoop * (index + 1));
    }
  } catch (error) {
    console.log("error", error);
  }
};

function getPaidInvoiceData() {
  return new Promise((resolve, reject) => {
    try {
      const options = {
        consumer_key: 'dc5a854e86c5bd48417c26ec1287cb5577f19d147acb48415e95ceb475ce04a5',
        consumer_secret_key: '4c53c17215ace3a0d0cb2530685c3609488ab7b8a2e3c3c0fe499779bd6c108a',
        token: '57c7ad8e5b88cdf0f4614066cc17822c3e57b5cfa596e54b6bbfa2dc2f7c4c4b',
        token_secret: '35b585473e5352b8120c7da0865fc6e4c3315a91e96458296fb091c35f2d4d81',
        realm: '1238234',
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
    // console.log(item);
    const itemData = item;
    const formatData= {
      internalid: itemData.internalid,
      type: itemData.type,
      datecreated: itemData.datecreated,
      tranid: itemData.tranid,
      amount: itemData.amount,
      custbody_riv_entity_cpnyname: itemData.custbody_riv_entity_cpnyname.replace(/'/g, "`"),
      custbody9: itemData.custbody9,
      duedate: itemData.duedate,
      custbody_source_system: itemData.custbody_source_system,
      payingtransaction: itemData.payingtransaction,
      amountremaining: itemData.amountremaining,
      created_at: itemData.created_at
    }

    // console.log("formatData", JSON.stringify(formatData));

    let tableStr = "";
    let valueStr = "";
    let updateStr = "";

    let objKyes = Object.keys(item);
    // console.log("objKyes",objKyes);
    objKyes.map((e, i) => {
      // console.log("e",e,"i",i);
      if (i > 0) {
        valueStr += ",";
        // console.log("valueStr", valueStr);
        updateStr += e != "customer_id" ? "," : "";
        // console.log("updateStr", updateStr);
      }
      if (e != "customer_id") {
        updateStr += e + "='" + formatData[e] + "'";
        // console.log("updateStr1", updateStr);
      }
      valueStr += "'" + formatData[e] + "'";
      // console.log("valueStr1", valueStr);
    });
    tableStr = objKyes.join(",");

    // console.log("tableStr", tableStr);
    // console.log("valueStr", valueStr);
    // console.log("updateStr", updateStr);
    const upsertQuery = `INSERT INTO dw_uat.netsuit_paid_invoices (${tableStr})
                        VALUES (${valueStr});`;
    // const upsertQuery = `INSERT INTO dw_uat.netsuit_paid_invoices (${tableStr})
    //                     VALUES (${valueStr}) ON DUPLICATE KEY
    //                     UPDATE ${updateStr};`;

    await connections.execute(upsertQuery);
  } catch (error) {
    console.log("error", error);
  }
}
