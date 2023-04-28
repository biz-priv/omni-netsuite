const AWS = require("aws-sdk");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const axios = require("axios");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const lineItemPayload = require("../../Helpers/netsuit_line_items_AP.json");
const {
  getConfig,
  getConnectionToRds,
  createAPFailedRecords,
  triggerReportLambda,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");



const apDbNamePrev = "dw_uat.";
const apDbName = apDbNamePrev + "interface_ap";

let userConfig = "";
let connections = "";

const today = getCustomDate();
const lineItemPerProcess = 500;
let totalCountPerLoop = 20;
let queryOffset = 0;
let queryinvoiceType = "IN"; // IN / CM
let queryOperator = "<=";
let queryInvoiceId = null;
let queryInvoiceNbr = null;
let queryVendorId = null;
const source_system = "OL";

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);

  // console.log("event", event);
  let currentCount = 0;
  totalCountPerLoop = event.hasOwnProperty("totalCountPerLoop")
    ? event.totalCountPerLoop
    : 21;
  queryOperator = event.hasOwnProperty("queryOperator")
    ? event.queryOperator
    : "<=";

  queryInvoiceId = event.hasOwnProperty("queryInvoiceId")
    ? event.queryInvoiceId
    : null;

  queryInvoiceNbr = event.hasOwnProperty("queryInvoiceNbr")
    ? event.queryInvoiceNbr
    : null;

  queryOffset = event.hasOwnProperty("queryOffset") ? event.queryOffset : 0;

  queryinvoiceType = event.hasOwnProperty("queryinvoiceType")
    ? event.queryinvoiceType
    : "IN";

  queryVendorId = event.hasOwnProperty("queryVendorId")
    ? event.queryVendorId
    : null;

  try {
    /**
     * Get connections
     */
    connections = await getConnectionToRds(process.env);

    if (queryOperator == ">") {
      // Update 500 line items per process
      console.log("> start");

      totalCountPerLoop = 0;
      if (queryInvoiceId != null && queryInvoiceId.length > 0) {
        console.log(">if");

        try {
          const invoiceDataList = await getInvoiceNbrData(
            connections,
            queryInvoiceNbr,
            true
          );
          await createInvoiceAndUpdateLineItems(
            queryInvoiceId,
            invoiceDataList
          );

          if (lineItemPerProcess >= invoiceDataList.length) {
            throw "Next Process";
          } else {
            dbc.end();
            return {
              hasMoreData: "true",
              queryOperator,
              queryOffset: queryOffset + lineItemPerProcess + 1,
              queryInvoiceId,
              queryInvoiceNbr,
              queryinvoiceType,
              queryVendorId,
            };
          }
        } catch (error) {
          dbc.end();
          return {
            hasMoreData: "true",
            queryOperator,
          };
        }
      } else {
        console.log("> else");

        try {
          let invoiceDataList = [];
          let orderData = [];
          try {
            orderData = await getDataGroupBy(connections);
            console.log("orderData", orderData.length);
          } catch (error) {
            dbc.end();
            await triggerReportLambda(
              process.env.NETSUIT_INVOICE_REPORT,
              "WT_AP"
            );
            return { hasMoreData: "false" };
          }
          queryInvoiceNbr = orderData[0].invoice_nbr;
          queryVendorId = orderData[0].vendor_id;
          queryinvoiceType = orderData[0].invoice_type;

          invoiceDataList = await getInvoiceNbrData(
            connections,
            queryInvoiceNbr,
            true
          );
          console.log("invoiceDataList", invoiceDataList.length);
          /**
           * set queryInvoiceId in this process and return update query
           */
          const queryData = await mainProcess(orderData[0], invoiceDataList);
          // console.log("queryData", queryData);
          await updateInvoiceId(connections, queryData);

          /**
           * if items <= 501 process next invoice
           * or send data for next update process of same invoice.
           */
          if (
            invoiceDataList.length <= lineItemPerProcess ||
            queryInvoiceId == null
          ) {
            throw "Next Invoice";
          } else {
            dbc.end();
            return {
              hasMoreData: "true",
              queryOperator,
              queryOffset: queryOffset + lineItemPerProcess + 1,
              queryInvoiceId,
              queryInvoiceNbr: queryInvoiceNbr,
              queryinvoiceType: orderData[0].invoice_type,
              queryVendorId,
            };
          }
        } catch (error) {
          console.log("error", error);
          dbc.end();
          return {
            hasMoreData: "true",
            queryOperator,
          };
        }
      }
    } else {
      //Create the main invoice with 500 line items 1st
      /**
       * Get data from db
       */
      let invoiceDataList = [];
      let orderData = [];
      let invoiceIDs = [];
      try {
        orderData = await getDataGroupBy(connections);
      } catch (error) {
        return {
          hasMoreData: "true",
          queryOperator: queryOperator == "<=" ? ">" : "<=",
        };
      }

      try {
        invoiceIDs = orderData.map((a) => "'" + a.invoice_nbr + "'");
        console.log("orderData**", orderData.length,orderData);
        console.log("invoiceIDs",invoiceIDs)
        if (orderData.length === 1) {
          console.log("length==1", orderData);
        }
        currentCount = orderData.length;
        invoiceDataList = await getInvoiceNbrData(connections, invoiceIDs);
        console.log("invoiceDataList",invoiceDataList.length)
      } catch (error) {
        console.log("error:getInvoiceNbrData:try:catch", error);
        console.log(
          "invoiceIDs:try:catch found on getDataGroupBy but not in getInvoiceNbrData",
          invoiceIDs
        );
        return {
          hasMoreData: "true",
          queryOperator,
        };
      }
      /**
       * 15 simultaneous process
       */
      const perLoop = 15;
      let queryData = "";
      for (let index = 0; index < (orderData.length + 1) / perLoop; index++) {
        let newArray = orderData.slice(
          index * perLoop,
          index * perLoop + perLoop
        );
        console.log("newArray",newArray)
        const data = await Promise.all(
          newArray.map(async (item) => {
            return await mainProcess(item, invoiceDataList);
          })
        );
        queryData += data.join("");
      }

      /**
       * Updating total 20 invoices at once
       */
      await updateInvoiceId(connections, queryData);

      if (currentCount < totalCountPerLoop) {
        queryOperator = ">";
      }
      dbc.end();
      return { hasMoreData: "true", queryOperator };
    }
  } catch (error) {
    console.log("error", error);
    dbc.end();
    await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "WT_AP");
    return { hasMoreData: "false" };
  }
};

/**
 * main process of netsuite AP API
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
        e.vendor_id == item.vendor_id &&
        e.invoice_type == item.invoice_type
      );
    });
    console.log("dataList",dataList.length)
    let getUpdateQueryList = "";

    /**
     * set single item and customer data
     */
    singleItem = dataList[0];
    console.log("singleItem",singleItem)

   

    /**
     * Make Json payload
     */
    const jsonPayload = await makeJsonPayload(dataList);
    //console.log("jsonPayload",jsonPayload)
    /**
     * create invoice
     */
    const invoiceId = await createInvoice(jsonPayload);

    if (queryOperator == ">") {
      queryInvoiceId = invoiceId;
    }

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
        if (error.hasOwnProperty("msg") && error.msg === "Unable to make json") {
          return getQuery;
        }
        await recordErrorResponse(singleItem, error);
        await createAPFailedRecords(connections, singleItem, error, "mysql",apDbNamePrev);
        return getQuery;
      } catch (error) {
        await recordErrorResponse(singleItem, error);
        await createAPFailedRecords(connections, singleItem, error, "mysql",apDbNamePrev);
        return getQuery;
      }
    }
  }
}

/**
 * get data
 * @param {*} connections
 * @returns
 */
async function getDataGroupBy(connections) {
  try {
    // const query = `
    //     SELECT iam.invoice_nbr, iam.vendor_id, count(ia.*) as tc, iam.invoice_type
    //     FROM interface_ap_master iam
    //     LEFT JOIN interface_ap ia ON 
    //     iam.invoice_nbr = ia.invoice_nbr and 
    //     iam.invoice_type = ia.invoice_type and 
    //     iam.vendor_id = ia.vendor_id and 
    //     iam.gc_code = ia.gc_code and 
    //     iam.source_system = ia.source_system and 
    //     iam.file_nbr = ia.file_nbr 
    //     WHERE ((iam.internal_id is null and iam.processed != 'F' and iam.vendor_internal_id !='')
    //             OR (iam.vendor_internal_id !='' and iam.processed ='F' and iam.processed_date < '${today}')
    //           )
    //           and iam.source_system = '${source_system}' and iam.invoice_nbr != '' 
    //     GROUP BY iam.invoice_nbr, iam.vendor_id, iam.invoice_type
    //     having tc ${queryOperator} ${lineItemPerProcess} limit ${totalCountPerLoop + 1
    //   }`;

    const query = `SELECT invoice_nbr, vendor_id,invoice_type,file_nbr,COUNT(*) as tc
    FROM
    ${apDbName} 
    WHERE  source_system = '${source_system}' and invoice_nbr != ''
    GROUP BY invoice_nbr, vendor_id, invoice_type, file_nbr
    having tc ${queryOperator} ${lineItemPerProcess} limit ${
  totalCountPerLoop + 1
}`
  console.log("query",query)
    const result = await connections.execute(query);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result[0];
  } catch (error) {
    throw "No data found.";
  }
}

async function getInvoiceNbrData(connections, invoice_nbr, isBigData = false) {
  try {
    let query =
    // `SELECT ia.*, iam.vendor_internal_id ,iam.currency_internal_id  FROM interface_ap ia 
    // left join interface_ap_master iam on 
    // ia.invoice_nbr = iam.invoice_nbr and
    // ia.invoice_type = iam.invoice_type and 
    // ia.vendor_id = iam.vendor_id and 
    // ia.gc_code = iam.gc_code and 
    // ia.source_system = iam.source_system and 
    // iam.file_nbr = ia.file_nbr 
    // where ia.source_system = '${source_system}' and `
    `SELECT * FROM  ${apDbName} 
      where source_system = '${source_system}' and `;
    if (isBigData) {
      query += ` invoice_nbr = '${invoice_nbr}' and invoice_type = '${queryinvoiceType}' and vendor_id ='${queryVendorId}' 
      order by id limit ${lineItemPerProcess + 1} offset ${queryOffset}`;
    } else {
      query += ` invoice_nbr in (${invoice_nbr.join(",")})`;
    }

    const result = await connections.query(query);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result[0];
  } catch (error) {
    console.log("error1", error);
    throw "getInvoiceNbrData: No data found.";
  }
}


async function makeJsonPayload(data) {
  try {
    const singleItem = data[0];
    // console.log("singleItem", singleItem)
    const hardcode = getHardcodeData();
    // console.log("hardcode", hardcode)

    /**
     * head level details
     */
    const payload = {
      entity: singleItem.vendor_internal_id ?? "",
      subsidiary: singleItem.subsidiary ?? "",
      trandate: dateFormat(singleItem.invoice_date) ?? "",
      tranid: singleItem.invoice_nbr ?? "",
      currency: singleItem.currency_internal_id ?? "",
      class: hardcode.class.head,
      department: hardcode.department.head,
      location: hardcode.location.head,
      custbody9: singleItem.housebill_nbr ?? "",
      custbody17: singleItem.email ?? "",
      custbody_source_system: hardcode.source_system,
      custbody_omni_po_hawb: singleItem.housebill_nbr ?? "",
      custbody_mode: singleItem?.mode_name ?? "",
      custbody_service_level: singleItem?.service_level ?? "",
      item: {
        items: data.map((e) => {
          return {
            taxcode: e.tax_code_internal_id ?? "",
            item: e.charge_cd_internal_id ?? "",
            description: e.charge_cd_desc ?? "",
            amount: +parseFloat(e.total).toFixed(2) ?? "",
            rate: +parseFloat(e.rate).toFixed(2) ?? "",
            department: hardcode.department.line ?? "",
            class: hardcode.class.line[
              e.business_segment.split(":")[1].trim().toLowerCase()
            ],
            location: hardcode.location.line,
            custcol_hawb: e.housebill_nbr ?? "",
            custcol3: e.sales_person ?? "",
            custcol5: e.master_bill_nbr ?? "",
            custcol2: {
              refName: e.controlling_stn ?? "",
            },
            custcol4: e.ref_nbr ?? "",
            custcol_riv_consol_nbr: e.consol_nbr ?? "",
            custcol_finalizedby: e.finalizedby ?? ""

          }
        })
      }
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
        url: "https://1238234-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/invoice",
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
        msg: "Netsuit AP Api Failed",
        response: "",
      });
    }
  });
}

async function createInvoiceAndUpdateLineItems(invoiceId, data) {
  try {
    const lineItemXml = await makeJsonForLineItems(
      invoiceId,
      JSON.parse(JSON.stringify(lineItemPayload)),
      data
    );
    await axios.post(process.env.NETSUIT_AR_API_ENDPOINT, lineItemXml, {
      headers: {
        Accept: "text/xml",
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: "update",
      },
    });
  } catch (error) {
    console.log("error", error);
  }
}

/**
 * prepear the query for update interface_ap_master
 * @param {*} item
 * @param {*} invoiceId
 * @param {*} isSuccess
 * @returns
 */
function getUpdateQuery(item, invoiceId, isSuccess = true) {
  try {
    console.log("invoice_nbr ", item.invoice_nbr, invoiceId);
    let query = `UPDATE ${apDbName} `;
    if (isSuccess) {
      query += ` SET internal_id = '${invoiceId}', processed = 'P', `;
    } else {
      query += ` SET internal_id = null, processed = 'F', `;
    }
    query += ` processed_date = '${today}'  WHERE source_system = '${source_system}' and invoice_nbr = '${item.invoice_nbr}' and invoice_type = '${item.invoice_type}'
              and vendor_id = '${item.vendor_id}';`;

    return query;
  } catch (error) {
    return "";
  }
}

/**
 * Update processed invoice ids
 * @param {*} connections
 * @param {*} query
 * @returns
 */
async function updateInvoiceId(connections, query) {
  try {
    const result = await connections.query(query);
    return result;
  } catch (error) {
    if (query.length > 0) {
      await sendDevNotification(
        source_system,
        "AP",
        "netsuite_ap_mcl updateInvoiceId",
        "Invoice is created But failed to update internal_id " + query,
        error
      );
    }
    throw {
      customError: true,
      msg: "Vendor Bill is created But failed to update internal_id",
    };
  }
}

/**
 * hardcode data for the payload.
 * @param {*} source_system
 * @returns
 */
// function getHardcodeData(isIntercompany = false) {
//   const data = {
//     source_system: "3",
//     class: {
//       head: "9",
//       line: getBusinessSegment(process.env.STAGE),
//     },
//     department: {
//       default: { head: "15", line: "2" },
//       intercompany: { head: "15", line: "1" },
//     },
//     location: { head: "18", line: "EXT ID: Take from DB" },
//   };
//   const departmentType = isIntercompany ? "intercompany" : "default";
//   return {
//     ...data,
//     department: data.department[departmentType],
//   };
// }

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

async function recordErrorResponse(item, error) {
  try {
    // let documentClient = new AWS.DynamoDB.DocumentClient({
    //   region: process.env.REGION,
    // });
    const data = {
      id: item.invoice_nbr + item.invoice_type,
      invoice_nbr: item.invoice_nbr,
      vendor_id: item.vendor_id,
      source_system: item.source_system,
      invoice_type: item.invoice_type,
      charge_cd_internal_id: item.charge_cd_internal_id,
      subsidiary: item.subsidiary,
      gc_code: item.gc_code,
      invoice_date: item.invoice_date.toLocaleString(),
      errorDescription: error?.msg,
      payload: error?.payload,
      response: error?.response,
      invoiceId: error?.invoiceId,
      status: "error",
      created_at: new Date().toLocaleString(),
    };
    // const params = {
    //   TableName: process.env.NETSUIT_AP_ERROR_TABLE,
    //   Item: data,
    // };
    // await documentClient.put(params).promise();
    await sendMail(data);
  } catch (e) { }
}

function sendMail(data) {
  return {};
  return new Promise((resolve, reject) => {
    try {
      let errorObj = JSON.parse(JSON.stringify(data));
      delete errorObj["payload"];
      delete errorObj["response"];

      const transporter = nodemailer.createTransport({
        host: process.env.NETSUIT_AR_ERROR_EMAIL_HOST,
        port: 587,
        secure: false, // true for 465, false for other ports
        auth: {
          user: process.env.NETSUIT_AR_ERROR_EMAIL_USER,
          pass: process.env.NETSUIT_AR_ERROR_EMAIL_PASS,
        },
      });

      const message = {
        from: `Netsuite <${process.env.NETSUIT_AR_ERROR_EMAIL_FROM}>`,
        to: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
        // to: "kazi.ali@bizcloudexperts.com,kiranv@bizcloudexperts.com,priyanka@bizcloudexperts.com,wwaller@omnilogistics.com",
        subject: `${source_system} - Netsuite AP ${process.env.STAGE.toUpperCase()} Invoices - Error`,
        html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="X-UA-Compatible" content="IE=edge">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Netsuite Error</title>
        </head>
        <body>
          <h3>Error msg:- ${errorObj.errorDescription} </h3>
          <p> Error Obj:- </p> <pre> ${JSON.stringify(errorObj, null, 4)} </pre>
          <p> Payload:- </p> <pre>${data?.payload ? htmlEncode(data?.payload) : "No Payload"
          }</pre>
          <p> Response:- </p> <pre>${data?.response ? htmlEncode(data?.response) : "No Response"
          }</pre>
        </body>
        </html>
        `,
      };

      transporter.sendMail(message, function (err, info) {
        if (err) {
          resolve(true);
        } else {
          resolve(true);
        }
      });
    } catch (error) {
      resolve(true);
    }
  });
}

function htmlEncode(data) {
  return data.replace(/[\u00A0-\u9999<>\&]/g, function (i) {
    return "&#" + i.charCodeAt(0) + ";";
  });
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

/**
 * check error already exists or not.
 * @param {*} singleItem
 * @returns
 */
async function checkSameError(singleItem, error) {
  try {
    const documentClient = new AWS.DynamoDB.DocumentClient({
      region: process.env.REGION,
    });

    const params = {
      TableName: process.env.NETSUIT_AP_ERROR_TABLE,
      FilterExpression:
        "#invoice_nbr = :invoice_nbr AND #errorDescription = :errorDescription",
      ExpressionAttributeNames: {
        "#invoice_nbr": "invoice_nbr",
        "#errorDescription": "errorDescription",
      },
      ExpressionAttributeValues: {
        ":invoice_nbr": singleItem.invoice_nbr,
        ":errorDescription": error?.msg,
      },
    };
    const res = await documentClient.scan(params).promise();
    if (res && res.Count && res.Count == 1) {
      return true;
    } else {
      return false;
    }
  } catch (error) {
    return false;
  }
}
