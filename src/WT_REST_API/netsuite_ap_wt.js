const AWS = require("aws-sdk");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const axios = require("axios");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const {
  getConfig,
  getConnectionToRds,
  createAPFailedRecords,
  triggerReportLambda,
  sendDevNotification,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");

let userConfig = "";
let connections = "";

const apDbNamePrev = "dw_uat.";
const apDbName = apDbNamePrev + "interface_ap";
const source_system = "WT";

const today = getCustomDate();
const lineItemPerProcess = 500;
let totalCountPerLoop = 20;
let queryOffset = 0;
let queryinvoiceType = "IN"; // IN / CM
let queryOperator = "<=";
let queryInvoiceId = null;
let queryInvoiceNbr = null;
let queryVendorId = null;

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

    /**
     * will work on this if section if rest can't handle more than 500 line items.
     */
    if (queryOperator == ">") {
      return { hasMoreData: "false" };
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
              "OL_AP"
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
        return { hasMoreData: "false" };
        // return {
        //   hasMoreData: "true",
        //   queryOperator: queryOperator == "<=" ? ">" : "<=",
        // };
      }

      try {
        invoiceIDs = orderData.map((a) => "'" + a.invoice_nbr + "'");
        console.log("orderData**", orderData.length, orderData);
        console.log("invoiceIDs", invoiceIDs);
        if (orderData.length === 1) {
          console.log("length==1", orderData);
        }
        currentCount = orderData.length;
        invoiceDataList = await getInvoiceNbrData(connections, invoiceIDs);
        console.log("invoiceDataList", invoiceDataList.length);
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

      /**
       * Updating total 20 invoices at once
       */
      await updateInvoiceId(connections, queryData);

      // if (currentCount < totalCountPerLoop) {
      //   queryOperator = ">";
      // }
      // dbc.end();
      // return { hasMoreData: "true", queryOperator };
      let hasMoreData = "false";
      if (currentCount > totalCountPerLoop) {
        hasMoreData = "true";
      } else {
        await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "WT_AP");
        hasMoreData = "false";
      }
      dbc.end();
      return { hasMoreData };
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
        e.invoice_type == item.invoice_type &&
        e.file_nbr == item.file_nbr
      );
    });
    console.log("dataList", dataList.length);
    let getUpdateQueryList = "";

    /**
     * set single item and customer data
     */
    singleItem = dataList[0];
    console.log("singleItem", singleItem);

    /**
     * Make Json payload
     */
    const jsonPayload = await makeJsonPayload(dataList);
    console.log("jsonPayload", jsonPayload);

    /**
     * create invoice
     */
    const invoiceId = await createInvoice(jsonPayload, singleItem);

    if (queryOperator == ">") {
      queryInvoiceId = invoiceId;
    }

    /**
     * update invoice id
     */
    const getQuery = getUpdateQuery(singleItem, invoiceId);
    return getQuery;
  } catch (error) {
    if (error.hasOwnProperty("customError")) {
      let getQuery = "";
      try {
        getQuery = getUpdateQuery(singleItem, null, false);
        await createAPFailedRecords(
          connections,
          singleItem,
          error,
          "mysql",
          apDbNamePrev
        );
        return getQuery;
      } catch (error) {
        await createAPFailedRecords(
          connections,
          singleItem,
          error,
          "mysql",
          apDbNamePrev
        );
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
    // const query = `SELECT invoice_nbr, vendor_id, invoice_type, file_nbr, COUNT(*) as tc
    //                 FROM ${apDbName}
    //                 WHERE  source_system = '${source_system}' and invoice_nbr != ''
    //                 GROUP BY invoice_nbr, vendor_id, invoice_type, file_nbr
    //                 having tc ${queryOperator} ${lineItemPerProcess}
    //                 limit ${totalCountPerLoop + 1}`;
    const query = `SELECT invoice_nbr, vendor_id, invoice_type
                    FROM ${apDbName} 
                    WHERE  ((internal_id is null and processed is null and vendor_internal_id is not null) or
                    (vendor_internal_id is not null and processed ='F' and processed_date < '${today}'))
                    and source_system = '${source_system}' and invoice_nbr != ''
                    GROUP BY invoice_nbr, vendor_id, invoice_type
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

async function getInvoiceNbrData(connections, invoice_nbr, isBigData = false) {
  try {
    let query = `SELECT * FROM  ${apDbName} where source_system = '${source_system}' and `;

    if (isBigData) {
      query += ` invoice_nbr = '${invoice_nbr}' and invoice_type = '${queryinvoiceType}' and vendor_id ='${queryVendorId}' 
      order by id limit ${lineItemPerProcess + 1} offset ${queryOffset}`;
    } else {
      query += ` invoice_nbr in (${invoice_nbr.join(",")})`;
    }

    const executeQuery = await connections.execute(query);
    const result = executeQuery[0];
    console.log("result", result);

    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.log("error1", error);
    throw "getInvoiceNbrData: No data found.";
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
      entity: singleItem.vendor_internal_id ?? "",
      subsidiary: singleItem.subsidiary ?? "",
      trandate: dateFormat(singleItem.invoice_date) ?? "",
      tranid: singleItem.invoice_nbr ?? "",
      currency: singleItem.currency_internal_id ?? "",
      class: hardcode.class.head,
      department: hardcode.department.head,
      location: hardcode.location.head,
      custbody9: singleItem.file_nbr ?? "",
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
            class:
              hardcode.class.line[
                e.business_segment.split(":")[1].trim().toLowerCase()
              ],
            location: {
              refName: e.handling_stn ?? "",
            },
            custcol_hawb: e.housebill_nbr ?? "",
            custcol3: e.sales_person ?? "",
            custcol5: e.master_bill_nbr ?? "",
            custcol2: {
              refName: e.controlling_stn ?? "",
            },
            custcol4: e.ref_nbr ?? "",
            custcol_riv_consol_nbr: e.consol_nbr ?? "",
            custcol_finalizedby: e.finalizedby ?? "",
          };
        }),
      },
    };
    if (singleItem.invoice_type == "IN") {
      payload.approvalStatus = { id: "2" };
    }

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

function createInvoice(payload, singleItem) {
  return new Promise((resolve, reject) => {
    try {
      const invTypeEndpoiont =
        singleItem.invoice_type == "IN" ? "vendorBill" : "vendorCredit";
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
          )}.suitetalk.api.netsuite.com/services/rest/record/v1/${invTypeEndpoiont}`,
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

/**
 * work on this function later
 * @param {*} invoiceId
 * @param {*} data
 */
async function createInvoiceAndUpdateLineItems(invoiceId, data) {
  // try {
  //   const lineItemXml = await makeJsonForLineItems(
  //     invoiceId,
  //     JSON.parse(JSON.stringify(lineItemPayload)),
  //     data
  //   );
  //   await axios.post(process.env.NETSUIT_AR_API_ENDPOINT, lineItemXml, {
  //     headers: {
  //       Accept: "text/xml",
  //       "Content-Type": "text/xml; charset=utf-8",
  //       SOAPAction: "update",
  //     },
  //   });
  // } catch (error) {
  //   console.log("error", error);
  // }
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
      query += ` SET internal_id = '1234', processed = 'P', `;
    } else {
      query += ` SET internal_id = null, processed = 'F', `;
    }
    query += ` processed_date = '${today}'  
                WHERE source_system = '${source_system}' and 
                      invoice_nbr = '${item.invoice_nbr}' and 
                      invoice_type = '${item.invoice_type}'and 
                      vendor_id = '${item.vendor_id}'`;

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
  for (let index = 0; index < query.length; index++) {
    const element = query[index];
    try {
      await connections.execute(element);
    } catch (error) {
      console.log("error:updateInvoiceId", error);
      await sendDevNotification(
        source_system,
        "AP",
        "netsuite_ap_mcl updateInvoiceId",
        "Invoice is created But failed to update internal_id " + element,
        error
      );
    }
  }
}

/**
 * hardcode data for the payload.
 * @param {*} source_system
 * @returns
 */

function getHardcodeData(isIntercompany = false) {
  const data = {
    source_system: "3",
    class: {
      head: "9",
      line: getBusinessSegment(process.env.STAGE),
    },
    department: {
      default: { head: "15", line: "2" },
      intercompany: { head: "15", line: "1" },
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
