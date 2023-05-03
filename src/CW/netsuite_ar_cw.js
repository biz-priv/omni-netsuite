const AWS = require("aws-sdk");
const { create, convert } = require("xmlbuilder2");
const crypto = require("crypto");
const axios = require("axios");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const nodemailer = require("nodemailer");
const payload = require("../../Helpers/netsuit_AR.json");
const {
  getConfig,
  getConnection,
  createARFailedRecords,
  triggerReportLambda,
  sendDevNotification,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");

let userConfig = "";
let connections = "";

const arDbName = "interface_ar_cw";
const source_system = "CW";
let totalCountPerLoop = 20;
let nextOffset = 0;
const today = getCustomDate();

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);

  let hasMoreData = "false";
  let currentCount = 0;
  totalCountPerLoop = event.hasOwnProperty("totalCountPerLoop")
    ? event.totalCountPerLoop
    : totalCountPerLoop;

  nextOffset = event.hasOwnProperty("nextOffsetCount")
    ? event.nextOffsetCount
    : 0;
  const nextOffsetCount = nextOffset + totalCountPerLoop + 1;
  try {
    /**
     * Get connections
     */
    connections = dbc(getConnection(process.env));

    /**
     * Get data from db
     */
    const orderData = await getDataGroupBy(connections);
    const invoiceIDs = orderData.map((a) => "'" + a.invoice_nbr + "'");
    console.log("orderData", orderData.length);
    currentCount = orderData.length;

    const invoiceDataList = await getInvoiceNbrData(connections, invoiceIDs);

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
      queryData += data.join("");
    }
    await updateInvoiceId(connections, queryData);

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
      await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "CW_AR");
      await startNextStep();
      hasMoreData = "false";
    }
    dbc.end();
    return { hasMoreData, nextOffsetCount };
  } catch (error) {
    dbc.end();
    await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "CW_AR");
    await startNextStep();
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
        e.customer_id == item.customer_id &&
        e.invoice_type == item.invoice_type &&
        e.gc_code == item.gc_code
      );
    });

    singleItem = dataList[0];

    /**
     * get customer from netsuit
     */
    let customerData = {
      entityId: singleItem.customer_id,
      entityInternalId: singleItem.customer_internal_id,
      currency: singleItem.curr_cd,
      currencyInternalId: singleItem.currency_internal_id,
    };
    let getUpdateQueryList = "";

    /**
     * Make Json to Xml payload
     */
    const xmlPayload = await makeJsonToXml(
      JSON.parse(JSON.stringify(payload)),
      dataList,
      customerData
    );

    /**
     * create Netsuit Invoice
     */
    const invoiceId = await createInvoice(xmlPayload, singleItem.invoice_type);

    /**
     * update invoice id
     */
    const getQuery = getUpdateQuery(singleItem, invoiceId);
    getUpdateQueryList += getQuery;
    return getUpdateQueryList;
  } catch (error) {
    if (error.hasOwnProperty("customError")) {
      let getQuery = "";
      try {
        getQuery = getUpdateQuery(singleItem, null, false);
        if (error.hasOwnProperty("msg") && error.msg === "Unable to make xml") {
          return getQuery;
        }
        await createARFailedRecords(connections, singleItem, error);
        return getQuery;
      } catch (error) {
        await createARFailedRecords(connections, singleItem, error);
        return getQuery;
      }
    }
  }
}

async function getDataGroupBy(connections) {
  try {
    const query = `SELECT distinct invoice_nbr,customer_id,invoice_type, gc_code FROM ${arDbName} where
    ((internal_id is null and processed != 'F' and customer_internal_id != '') or
     (customer_internal_id != '' and processed ='F' and processed_date < '${today}'))
    and ((intercompany='Y' and pairing_available_flag ='Y') or intercompany='N')
    and source_system = '${source_system}' and invoice_nbr != ''
    order by invoice_nbr,customer_id,invoice_type, gc_code 
    limit ${totalCountPerLoop + 1} `;
    console.log("query", query);

    const result = await connections.query(query);
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

    const result = await connections.query(query);
    if (!result || result.length == 0 || !result[0].customer_id) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
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

async function makeJsonToXml(payload, data, customerData) {
  try {
    /**
     * get auth keys
     */
    const auth = getOAuthKeys(userConfig);
    const singleItem = data[0];
    const hardcode = getHardcodeData(
      singleItem.intercompany == "Y" ? true : false
    );
    payload["soap:Envelope"]["soap:Header"] = {
      tokenPassport: {
        "@xmlns": "urn:messages_2018_2.platform.webservices.netsuite.com",
        account: {
          "@xmlns": "urn:core_2018_2.platform.webservices.netsuite.com",
          "#": auth.account,
        },
        consumerKey: {
          "@xmlns": "urn:core_2018_2.platform.webservices.netsuite.com",
          "#": auth.consumerKey,
        },
        token: {
          "@xmlns": "urn:core_2018_2.platform.webservices.netsuite.com",
          "#": auth.tokenKey,
        },
        nonce: {
          "@xmlns": "urn:core_2018_2.platform.webservices.netsuite.com",
          "#": auth.nonce,
        },
        timestamp: {
          "@xmlns": "urn:core_2018_2.platform.webservices.netsuite.com",
          "#": auth.timeStamp,
        },
        signature: {
          "@algorithm": "HMAC_SHA256",
          "@xmlns": "urn:core_2018_2.platform.webservices.netsuite.com",
          "#": auth.base64hash,
        },
      },
    };

    let recode = payload["soap:Envelope"]["soap:Body"]["add"]["record"];
    recode["q1:entity"]["@internalId"] = customerData.entityInternalId; //This is internal ID for the customer.
    recode["q1:tranId"] = singleItem.invoice_nbr; //invoice ID
    recode["q1:tranDate"] = dateFormat(singleItem.invoice_date); //invoice date

    recode["q1:class"]["@internalId"] = hardcode.class.head;
    recode["q1:department"]["@internalId"] = hardcode.department.head;
    recode["q1:location"]["@internalId"] = hardcode.location.head;
    recode["q1:subsidiary"]["@internalId"] = singleItem.subsidiary;
    recode["q1:currency"]["@internalId"] = customerData.currencyInternalId;
    recode["q1:otherRefNum"] = singleItem.order_ref; //prev:- customer_po is the bill to ref nbr new:- order_ref
    recode["q1:memo"] = ""; // (leave out for worldtrak)

    recode["q1:itemList"]["q1:item"] = data.map((e) => {
      return {
        "q1:taxCode": {
          "@internalId": e.tax_code_internal_id,
        },
        "q1:item": {
          "@internalId": e.charge_cd_internal_id,
        },
        "q1:description": e.charge_cd_desc,
        "q1:amount": e.total,
        "q1:rate": e.rate,
        "q1:department": {
          "@internalId": hardcode.department.line,
        },
        "q1:class": {
          "@internalId":
            hardcode.class.line[
              e.business_segment.split(":")[1].trim().toLowerCase()
            ],
        },
        "q1:location": {
          "@externalId": e.handling_stn,
        },
        "q1:customFieldList": {
          customField: [
            {
              "@internalId": "760",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.housebill_nbr ?? "",
            },
            {
              "@internalId": "1167",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.sales_person ?? "",
            },
            {
              "@internalId": "1727",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.master_bill_nbr ?? "",
            },
            {
              "@internalId": "1166",
              "@xsi:type": "SelectCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: { "@externalId": e.controlling_stn },
            },
            {
              "@internalId": "1164",
              "@xsi:type": "DateCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: dateFormat(e.ready_date),
            },
          ],
        },
      };
    });

    recode["q1:customFieldList"]["customField"] = [
      {
        "@internalId": "1745",
        "@xsi:type": "DateCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: dateFormat(singleItem.finalized_date),
      },
      {
        "@internalId": "1730",
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem.file_nbr ?? "",
      },
      {
        "@internalId": "1744",
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem.email ?? "",
      },
      {
        "@internalId": "2327",
        "@xsi:type": "SelectCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: {
          "@typeId": "752",
          "@internalId": hardcode.source_system,
        },
      },
      {
        "@internalId": "2698",
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem?.zip_code ?? "",
      },
      {
        "@internalId": "2673", //mode
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem?.mode_name ?? "",
      },
      {
        "@internalId": "2674", //service level
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem?.service_level ?? "",
      },
    ];

    /**
     * check if IN or CM (IN => invoice , CM => credit)
     */

    recode["@xsi:type"] =
      singleItem.invoice_type == "IN" ? "q1:Invoice" : "q1:CreditMemo";
    recode["@xmlns:q1"] =
      singleItem.invoice_type == "IN"
        ? "urn:sales_2021_2.transactions.webservices.netsuite.com"
        : "urn:customers_2021_2.transactions.webservices.netsuite.com";

    payload["soap:Envelope"]["soap:Body"]["add"]["record"] = recode;
    const doc = create(payload);
    return doc.end({ prettyPrint: true });
  } catch (error) {
    await sendDevNotification(
      source_system,
      "AR",
      "netsuite_ar_cw makeJsonToXml",
      data[0],
      error
    );
    throw {
      customError: true,
      msg: "Unable to make xml",
      data: data[0],
    };
  }
}

async function createInvoice(soapPayload, type) {
  try {
    const res = await axios.post(
      process.env.NETSUIT_AR_API_ENDPOINT,
      soapPayload,
      {
        headers: {
          Accept: "text/xml",
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: "add",
        },
      }
    );

    const obj = convert(res.data, { format: "object" });

    if (
      res.status == 200 &&
      obj["soapenv:Envelope"]["soapenv:Body"]["addResponse"]["writeResponse"][
        "platformCore:status"
      ]["@isSuccess"] == "true"
    ) {
      return obj["soapenv:Envelope"]["soapenv:Body"]["addResponse"][
        "writeResponse"
      ]["baseRef"]["@internalId"];
    } else if (res.status == 200) {
      throw {
        customError: true,
        msg: obj["soapenv:Envelope"]["soapenv:Body"]["addResponse"][
          "writeResponse"
        ]["platformCore:status"]["platformCore:statusDetail"][
          "platformCore:message"
        ],
        payload: soapPayload,
        response: res.data,
      };
    } else {
      throw {
        customError: true,
        msg:
          type == "IN"
            ? "Unable to create invoice. Internal Server Error"
            : "Unable to create CreditMemo. Internal Server Error",
        payload: soapPayload,
        response: res.data,
      };
    }
  } catch (error) {
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
              and invoice_type = '${item.invoice_type}'and customer_id = '${item.customer_id}' 
              and gc_code = '${item.gc_code}';`;

    return query;
  } catch (error) {
    return "";
  }
}

async function updateInvoiceId(connections, query) {
  try {
    const result = await connections.query(query);
    return result;
  } catch (error) {
    if (query.length > 0) {
      await sendDevNotification(
        source_system,
        "AR",
        "netsuite_ar_cw updateInvoiceId",
        "Invoice is created But failed to update internal_id " + query,
        error
      );
    }
    throw {
      customError: true,
      msg: "Invoice is created But failed to update internal_id",
      invoiceId,
    };
  }
}

function getHardcodeData(isIntercompany = false) {
  const data = {
    source_system: "1",
    class: {
      head: "9",
      line: getBusinessSegment(process.env.STAGE),
    },
    department: {
      default: { head: "15", line: "1" },
      intercompany: { head: "16", line: "1" },
    },
    location: { head: "18", line: "EXT ID: Take from DB" },
  };
  const departmentType = isIntercompany ? "intercompany" : "default";
  return {
    ...data,
    department: data.department[departmentType],
  };
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

async function startNextStep() {
  return new Promise((resolve, reject) => {
    try {
      const params = {
        stateMachineArn: process.env.NETSUITE_VENDOR_STEP_ARN,
        input: JSON.stringify({}),
      };
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.startExecution(params, (err, data) => {
        if (err) {
          console.log("Netsuit NETSUITE_VENDOR_STEP_ARN trigger failed");
          resolve(false);
        } else {
          console.log("Netsuit NETSUITE_VENDOR_STEP_ARN started");
          resolve(true);
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}
