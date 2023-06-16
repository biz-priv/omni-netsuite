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

const fromDate = "05/01/2022";
const toDate = "05/02/2022";
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
        consumer_key: userConfig.token.consumer_key,
        consumer_secret_key: userConfig.token.consumer_secret,
        token: userConfig.token.token_key,
        token_secret: userConfig.token.token_secret,
        realm: userConfig.account,
        url: `https://${userConfig.account
          .toLowerCase()
          .split("_")
          .join(
            "-"
          )}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=845&deploy=1&custscript_mfc_date_from=${fromDate}&custscript_mfc_date_to=${toDate}`,
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

    let tableStr = "";
    let valueStr = "";
    let updateStr = "";

    let objKyes = Object.keys(item);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
        updateStr += e != "customer_id" ? "," : "";
      }
      if (e != "customer_id") {
        updateStr += e + "='" + item[e] + "'";
      }
      valueStr += "'" + item[e] + "'";
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
