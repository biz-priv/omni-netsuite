const AWS = require("aws-sdk");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const axios = require("axios");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const {
  getConfig,
  getConnectionToRds,
  createARFailedRecords,
  triggerReportLambda,
  sendDevNotification,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");

let userConfig = "";
let connections = "";

const arDbNamePrev = "dw_uat.";
const arDbName = arDbNamePrev + "interface_ar";
const source_system = "WT";
let totalCountPerLoop = 20;
const today = getCustomDate();

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);
  let hasMoreData = "false";
  let currentCount = 0;
  totalCountPerLoop = event.hasOwnProperty("totalCountPerLoop")
    ? event.totalCountPerLoop
    : totalCountPerLoop;

  try {
    /**
     * Get connections
     */
    connections = await getConnectionToRds(process.env);

    /**
     * Get data from db
     */
    const orderData = await getDataGroupBy(connections);
    console.log("orderData", orderData.length, orderData[0]);
    const invoiceIDs = orderData.map((a) => "'" + a.invoice_nbr + "'");
    console.log("invoiceIDs", invoiceIDs);

    currentCount = orderData.length;
    const invoiceDataList = await getInvoiceNbrData(connections, invoiceIDs);
    console.log("invoiceDataList", invoiceDataList.length);

    /**
     * 5 simultaneous process
     */
    const perLoop = 15;
    let queryData = [];
    for (let index = 0; index < (orderData.length + 1) / perLoop; index++) {
      let newArray = orderData.slice(
        index * perLoop,
        index * perLoop + perLoop
      );

      const data = await Promise.all(
        newArray.map(async (item) => {
          return await mainProcess(item, invoiceDataList);
        })
      );
      queryData = [...queryData, ...data];
    }

    console.log("queryData", queryData);
    await updateInvoiceId(connections, queryData);

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
      await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "WT_AR");
      hasMoreData = "false";
    }
    dbc.end();
    return { hasMoreData };
  } catch (error) {
    dbc.end();
    await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "WT_AR");
    return { hasMoreData: "false" };
  }
};

/**
 * main process of netsuite AR API
 * @param {*} connections
 * @param {*} item
 */
async function mainProcess(item, invoiceDataList) {
  let singleItem = null;
  try {
    /**
     * get invoice obj from DB
     */
    const dataList = invoiceDataList.filter((e) => {
      return (
        e.invoice_nbr == item.invoice_nbr &&
        e.invoice_type == item.invoice_type &&
        e.file_nbr == item.file_nbr
      );
    });

    singleItem = dataList[0];
    // console.log("singleItem", singleItem);

    /**
     * Make Json payload
     */
    const jsonPayload = await makeJsonPayload(dataList);

    /**
     * create Netsuit Invoice
     */
    const invoiceId = await createInvoice(jsonPayload);
    console.log("invoiceId", invoiceId);

    /**
     * update invoice id
     */
    const getQuery = getUpdateQuery(singleItem, invoiceId);
    return getQuery;
  } catch (error) {
    console.log("error:process", error);
    if (error.hasOwnProperty("customError")) {
      let getQuery = "";
      try {
        getQuery = getUpdateQuery(singleItem, null, false);
        await createARFailedRecords(
          connections,
          singleItem,
          error,
          "mysql",
          arDbNamePrev
        );
        return getQuery;
      } catch (error) {
        await createARFailedRecords(
          connections,
          singleItem,
          error,
          "mysql",
          arDbNamePrev
        );
        return getQuery;
      }
    }
  }
}

async function getDataGroupBy(connections) {
  try {
    const query = `SELECT distinct invoice_nbr, invoice_type, file_nbr FROM ${arDbName} where 
                   source_system = '${source_system}' and invoice_nbr is not null
                  limit ${totalCountPerLoop + 1}`;
    console.log("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    throw "No data found.";
  }
}

async function getInvoiceNbrData(connections, invoice_nbr) {
  try {
    const query = `select * from ${arDbName} where source_system = '${source_system}' 
    and invoice_nbr in (${invoice_nbr.join(",")})`;
    console.log("query", query);

    const executeQuery = await connections.execute(query);
    const result = executeQuery[0];
    console.log("result", result);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.log("error");
    throw "No data found.";
  }
}

async function makeJsonPayload(data) {
  try {
    const singleItem = data[0];
    const hardcode = getHardcodeData();

    /**
     * head level details
     */
    const payload = {
      tranid: singleItem.invoice_nbr ?? "",
      trandate: dateFormat(singleItem.invoice_date) ?? "",
      department: hardcode.department.head,
      class: hardcode.class.head,
      location: hardcode.location.head,
      custbody_source_system: hardcode.source_system,
      entity: singleItem.customer_internal_id ?? "",
      subsidiary: singleItem.subsidiary ?? "",
      currency: singleItem.currency_internal_id ?? "",
      otherrefnum: singleItem.file_nbr ?? "",
      custbody_mode: singleItem?.mode_name ?? "",
      custbody_service_level: singleItem?.service_level ?? "",
      custbody18: singleItem.finalized_date ?? "",
      custbody9: singleItem.housebill_nbr ?? "",
      custbody17: singleItem.email ?? "",
      item: {
        items: data.map((e) => {
          return {
            item: e.charge_cd_internal_id ?? "",
            description: e?.charge_cd_desc ?? "",
            amount: +parseFloat(e.total).toFixed(2) ?? "",
            rate: +parseFloat(e.rate).toFixed(2) ?? "",
            department: hardcode.department.line ?? "",
            class:
              hardcode.class.line[
                e.business_segment.split(":")[1].trim().toLowerCase()
              ],
            location: hardcode.location.line,
            custcol_hawb: e.housebill_nbr ?? "",
            custcol3: e.sales_person ?? "",
            custcol5: e.master_bill_nbr ?? "",
            custcol2: {
              refName: e.controlling_stn ?? "",
            },
            custcol1: e.ready_date ? e.ready_date.toISOString() : "",
          };
        }),
      },
    };

    console.log("payload", JSON.stringify(payload));
    return payload;
  } catch (error) {
    console.log("error payload", error);
  }
}

function getAuthorizationHeader(options) {
  const oauth = OAuth({
    consumer: {
      key: options.consumer_key,
      secret: options.consumer_secret_key,
    },
    realm: options.realm,
    signature_method: "HMAC-SHA256",
    hash_function(base_string, key) {
      return crypto
        .createHmac("sha256", key)
        .update(base_string)
        .digest("base64");
    },
  });
  return oauth.toHeader(
    oauth.authorize(
      {
        url: options.url,
        method: options.method,
      },
      {
        key: options.token,
        secret: options.token_secret,
      }
    )
  );
}

function createInvoice(payload) {
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
          )}.suitetalk.api.netsuite.com/services/rest/record/v1/invoice`,
        method: "POST",
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
        data: JSON.stringify(payload),
      };
      console.log("configApi", configApi);

      axios
        .request(configApi)
        .then((response) => {
          console.log("response", response.status);
          console.log(JSON.stringify(response.data));
          resolve("success");
        })
        .catch((error) => {
          console.log(error.response.status);
          console.log(error.response.data);
          reject({
            customError: true,
            msg: error?.response?.data?.["o:errorDetails"][0]?.detail.replace(
              /'/g,
              "`"
            ),
            payload: JSON.stringify(payload),
            response: JSON.stringify(error.response.data).replace(/'/g, "`"),
          });
        });
    } catch (error) {
      console.log("error:createInvoice:main:catch", error);
      reject({
        customError: true,
        msg: "Netsuit AR Api Failed",
        response: "",
      });
    }
  });
}

function getUpdateQuery(item, invoiceId, isSuccess = true) {
  try {
    console.log("invoice_nbr ", item.invoice_nbr, invoiceId);
    let query = `UPDATE ${arDbName} `;
    if (isSuccess) {
      query += ` SET internal_id = 1234, processed = 'P', `;
    } else {
      query += ` SET internal_id = null, processed = 'F', `;
    }
    query += `processed_date = '${today}' 
              WHERE source_system = '${source_system}' and invoice_nbr = '${item.invoice_nbr}' 
              and invoice_type = '${item.invoice_type}' and file_nbr = '${item.file_nbr}' ;`;
    console.log("query", query);
    return query;
  } catch (error) {
    return "";
  }
}

async function updateInvoiceId(connections, query) {
  for (let index = 0; index < query.length; index++) {
    const element = query[index];
    try {
      await connections.execute(element);
    } catch (error) {
      console.log("error:updateInvoiceId", error);
      await sendDevNotification(
        source_system,
        "AR",
        "netsuite_ar_wt updateInvoiceId",
        "Invoice is created But failed to update internal_id " + element,
        error
      );
    }
  }
}

function getHardcodeData() {
  const data = {
    source_system: "6",
    class: {
      head: "9",
      line: getBusinessSegment(process.env.STAGE),
    },
    department: { head: "15", line: "1" },
    location: { head: "88", line: "88" },
  };
  return data;
}

function dateFormat(param) {
  const date = new Date(param);
  return (
    date.getFullYear() +
    "-" +
    ("00" + (date.getMonth() + 1)).slice(-2) +
    "-" +
    ("00" + date.getDate()).slice(-2) +
    "T11:05:03.000Z"
  );
}

function getCustomDate() {
  const date = new Date();
  let ye = new Intl.DateTimeFormat("en", { year: "numeric" }).format(date);
  let mo = new Intl.DateTimeFormat("en", { month: "2-digit" }).format(date);
  let da = new Intl.DateTimeFormat("en", { day: "2-digit" }).format(date);
  return `${ye}-${mo}-${da}`;
}
