const AWS = require("aws-sdk");
const crypto = require("crypto");
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
const source_system = "TMS";
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
    let queryData = "";
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
      console.log("data", data);
      queryData += data.join("");
      console.log("queryData", queryData);
    }
    return {};

    await updateInvoiceId(connections, queryData);

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
      // await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "MCL_AR");
      hasMoreData = "false";
    }
    dbc.end();
    return { hasMoreData };
  } catch (error) {
    dbc.end();
    // await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "MCL_AR");
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
     * get customer from netsuit
     */
    let customerData = {
      entityId: singleItem.customer_id,
      entityInternalId: singleItem.customer_internal_id,
      currency: singleItem.curr_cd,
      currencyInternalId: singleItem.currency_internal_id,
    };
    // console.log("customerData", customerData);
    let getUpdateQueryList = "";

    /**
     * Make Json payload
     */
    const jsonPayload = await makeJsonPayload(dataList, customerData);

    /**
     * create Netsuit Invoice
     */
    const invoiceId = await createInvoice(jsonPayload, singleItem.invoice_type);
    console.log("invoiceId", invoiceId);

    /**
     * update invoice id
     */
    const getQuery = getUpdateQuery(singleItem, invoiceId);
    getUpdateQueryList += getQuery;
    console.log("getUpdateQueryList", getUpdateQueryList);
    return getUpdateQueryList;
  } catch (error) {
    console.log("error:process", error);
    if (error.hasOwnProperty("customError")) {
      let getQuery = "";
      try {
        getQuery = getUpdateQuery(singleItem, null, false);
        if (error.hasOwnProperty("msg") && error.msg === "Unable to make xml") {
          return getQuery;
        }
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
    const query = `SELECT distinct invoice_nbr, invoice_type, file_nbr 
                    FROM ${arDbName} where source_system = '${source_system}' and invoice_nbr != ''
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
    if (!result || result.length == 0 || !result[0].customer_id) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.log("error");
    throw "No data found.";
  }
}

function getOAuthKeys(configuration) {
  const res = {};
  res.account = configuration.account;
  res.consumerKey = configuration.token.consumer_key;
  res.tokenKey = configuration.token.token_key;

  res.nonce =
    Math.random().toString(36).substr(2, 15) +
    Math.random().toString(36).substr(2, 15);

  res.timeStamp = Math.round(new Date().getTime() / 1000);

  const key = `${configuration.token.consumer_secret}&${configuration.token.token_secret}`;

  const baseString =
    configuration.account +
    "&" +
    configuration.token.consumer_key +
    "&" +
    configuration.token.token_key +
    "&" +
    res.nonce +
    "&" +
    res.timeStamp;

  res.base64hash = crypto
    .createHmac("sha256", Buffer.from(key, "utf8"))
    .update(baseString)
    .digest(null, null)
    .toString("base64");
  return res;
}

async function makeJsonPayload(data, customerData) {
  try {
    /**
     * get auth keys
     */
    const auth = getOAuthKeys(userConfig);
    // console.log("auth", auth);
    const singleItem = data[0];
    // console.log("singleItem", singleItem)
    const hardcode = getHardcodeData();
    // console.log("hardcode", hardcode)

    const item = data.map((e) => {
      return {
        item: e.internal_id ?? "",
        description: e?.charge_cd_desc ?? "",
        amount: parseFloat(e.total)?.toFixed(2) ?? "",
        rate: parseFloat(e.rate)?.toFixed(2) ?? "",
        department: hardcode.department.line ?? "",
        class: hardcode.class.head ?? "",
        location: e.handling_stn ?? "",
        custcol_hawb: e.housebill_nbr ?? "",
        custcol3: e.sales_person ?? "",
        custcol5: e.master_bill_nbr ?? "",
        custcol2: e.controlling_stn ?? "",
        custcol1: e.ready_date ? e.ready_date.toISOString() : "",
      };
    });
    const payload = {
      entity: customerData.entityInternalId ?? "",
      trandate: dateFormat(singleItem.invoice_date) ?? "",
      tranid: singleItem.invoice_nbr ?? "",
      department: hardcode.department.head ?? "",
      class: hardcode.class.head ?? "",
      location: hardcode.location.head ?? "",
      subsidiary: singleItem.subsidiary ?? "",
      currency: customerData.currencyInternalId ?? "",
      otherrefnum: singleItem.file_nbr ?? "",
      custbody18: singleItem.finalized_date ?? "",
      custbody9: singleItem.housebill_nbr ?? "",
      custbody17: singleItem.email ?? "",
      custbody_source_system: hardcode.source_system ?? "",
      item: {
        items: item,
      },
    };

    console.log("payload", JSON.stringify(payload));
    return payload;
  } catch (error) {
    console.log("error payload", error);
  }
}

async function createInvoice(jsonPayload, type) {
  try {
    const res = await axios.post(
      process.env.NETSUIT_AR_API_ENDPOINT,
      jsonPayload,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }
    );
    console.log("res", res);

    if (res.status == 200 && res.data.success == true) {
      return res.data.internalId;
    } else if (res.status == 200) {
      throw {
        customError: true,
        msg: res.data.errorMessage,
        payload: jsonPayload,
        response: res.data,
      };
    } else {
      throw {
        customError: true,
        msg:
          type == "IN"
            ? "Unable to create invoice. Internal Server Error"
            : "Unable to create CreditMemo. Internal Server Error",
        payload: jsonPayload,
        response: res.data,
      };
    }
  } catch (error) {
    console.log("error");
    if (error.hasOwnProperty("customError")) {
      throw error;
    } else {
      throw {
        msg: "Netsuit AR Api Failed",
      };
    }
  }
}

function getUpdateQuery(item, invoiceId, isSuccess = true) {
  try {
    console.log(
      "invoice_nbr " + item.invoice_type,
      item.invoice_nbr,
      invoiceId
    );
    let query = `UPDATE ${arDbName} `;
    if (isSuccess) {
      query += ` SET internal_id = '${invoiceId}', processed = 'P', `;
    } else {
      query += ` SET internal_id = null, processed = 'F', `;
    }
    query += `processed_date = '${today}' 
              WHERE source_system = '${source_system}' and invoice_nbr = '${item.invoice_nbr}' 
              and invoice_type = '${item.invoice_type}' ;`;
    console.log("query", query);
    return query;
  } catch (error) {
    return "";
  }
}

async function updateInvoiceId(connections, query) {
  try {
    const result = await connections.execute(query);
    console.log("result", result);
    return result;
  } catch (error) {
    if (query.length > 0) {
      await sendDevNotification(
        source_system,
        "AR",
        "netsuite_ar_wt updateInvoiceId",
        "Invoice is created But failed to update internal_id " + query,
        error
      );
    }
    throw {
      customError: true,
      msg: "Invoice is created But failed to update internal_id",
      query,
    };
  }
}

function getHardcodeData() {
  const data = {
    source_system: "3",
    class: {
      head: "9",
      line: getBusinessSegment(process.env.STAGE),
    },
    department: { head: "15", line: "1" },
    location: { head: "18", line: "EXT ID: Take from DB" },
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
