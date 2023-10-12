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
  setDelay,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");

let userConfig = "";
let connections = "";

const apDbNamePrev = process.env.DATABASE_NAME;
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

  console.info("event", event);
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
      // Update 500 line items per process
      console.info("> start");

      totalCountPerLoop = 0;
      if (queryInvoiceId != null && queryInvoiceId.toString().length > 0) {
        console.info(">if");

        try {
          const invoiceDataList = await getInvoiceNbrData(
            connections,
            queryInvoiceNbr,
            true
          );

          try {
            await createInvoiceAndUpdateLineItems(
              queryInvoiceId,
              invoiceDataList
            );
          } catch (error) {
            console.error("work later");
          }

          if (lineItemPerProcess >= invoiceDataList.length) {
            throw "Next Process";
          } else {
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
          return {
            hasMoreData: "true",
            queryOperator,
          };
        }
      } else {
        console.info("> else");

        try {
          let invoiceDataList = [];
          let orderData = [];
          try {
            orderData = await getDataGroupBy(connections);
            console.info("orderData", orderData.length);
          } catch (error) {
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
          console.info("invoiceDataList", invoiceDataList.length);
          /**
           * set queryInvoiceId in this process and return update query
           */
          const queryData = await mainProcess(orderData[0], invoiceDataList);
          await updateInvoiceId(connections, [queryData]);

          /**
           * if items <= 501 process next invoice
           * or send data for next update process of same invoice.
           */
          if (
            invoiceDataList.length <= lineItemPerProcess ||
            queryInvoiceId == null
          ) {
            console.info("next invoice");
            throw "Next Invoice";
          } else {
            console.info("next exec", {
              hasMoreData: "true",
              queryOperator,
              queryOffset: queryOffset + lineItemPerProcess + 1,
              queryInvoiceId,
              queryInvoiceNbr: queryInvoiceNbr,
              queryinvoiceType: orderData[0].invoice_type,
              queryVendorId,
            });

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
          console.error("error", error);
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
        console.info("orderData**", orderData.length);
        console.info("invoiceIDs", invoiceIDs);
        if (orderData.length === 1) {
          console.info("length==1", orderData);
        }
        currentCount = orderData.length;
        invoiceDataList = await getInvoiceNbrData(connections, invoiceIDs);
        console.info("invoiceDataList", invoiceDataList.length);
      } catch (error) {
        console.error("error:getInvoiceNbrData:try:catch", error);
        console.error(
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

      if (currentCount < totalCountPerLoop) {
        queryOperator = ">";
      }
      return { hasMoreData: "true", queryOperator };
    }
  } catch (error) {
    console.error("error", error);
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

    /**
     * set single item and customer data
     */
    singleItem = dataList[0];

    /**
     * delay for half second
     */
    await setDelay(1);

    /**
     * Make Json payload
     */
    const jsonPayload = await makeJsonPayload(dataList);

    /**
     * create invoice
     */
    const invoiceId = await createInvoice(jsonPayload, singleItem);


    if (queryOperator == ">") {
      queryInvoiceId = invoiceId.toString();
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
    const query = `SELECT invoice_nbr, vendor_id, invoice_type, count(*) as tc
                    FROM ${apDbName} 
                    WHERE  ((internal_id is null and processed is null and vendor_internal_id is not null) or
                    (vendor_internal_id is not null and processed ='F' and processed_date < '${today}'))
                    and source_system = '${source_system}' and invoice_nbr != ''
                    GROUP BY invoice_nbr, vendor_id, invoice_type
                    having tc ${queryOperator} ${lineItemPerProcess} 
                    limit ${totalCountPerLoop + 1}`;
    console.info("query", query);
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

    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.error("getInvoiceNbrData:error", error);
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
      custbody_mfc_omni_unique_key:
        singleItem.invoice_nbr +
        "-" +
        singleItem.vendor_id +
        "-" +
        singleItem.invoice_type, //invoice_nbr, vendor_id, invoice_type
      entity: singleItem.vendor_internal_id ?? "",
      subsidiary: singleItem.subsidiary ?? "",
      trandate: singleItem.invoice_date
        ? dateFormat(singleItem.invoice_date)
        : "",
      tranid: singleItem.invoice_nbr ?? "",
      currency: singleItem.currency_internal_id ?? "",
      class: hardcode.class.head,
      department: hardcode.department.head,
      location: hardcode.location.head,
      custbody9: singleItem.file_nbr ?? "",
      custbody17: singleItem.email ?? "",
      custbody_source_system: hardcode.source_system,
      custbodymfc_tmsinvoice: singleItem.invoice_nbr ?? "",
      custbody_omni_po_hawb: singleItem.housebill_nbr ?? "",
      custbody_mode: singleItem?.mode_name ?? "",
      custbody_service_level: singleItem?.service_level ?? "",
      item: data.map((e) => {
        return {
          // custcol_mfc_line_unique_key:"",
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
          custcol_actual_weight: e.actual_weight ?? "",//dev: custcol20  prod: custcol_actual_weight
          custcol_destination_on_zip: e.dest_zip ?? "",//dev: custcol19 prod: custcol_destination_on_zip
          custcol_destination_on_state: e.dest_state ?? "",//dev: custcol18 prod: custcol_destination_on_state
          custcol_destination_on_country: e.dest_country ?? "",//dev: custcol17 prod: custcol_destination_on_country
          custcol_miles_distance: e.miles ?? "",
          custcol_chargeable_weight: e.chargeable_weight ?? "",
        };
      }),
    };

    if (singleItem.invoice_type == "IN") {
      payload.approvalstatus = "2";
    }

    return payload;
  } catch (error) {
    console.error("error payload", error);
    await sendDevNotification(
      source_system,
      "AP",
      "netsuite_ap_wt payload error",
      data[0],
      error
    );
    throw {
      customError: true,
      msg: "Unable to make payload",
      data: data[0],
    };
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

async function createInvoice(payload, singleItem) {
  try {
    const endpoiont =
      singleItem.invoice_type == "IN"
        ? process.env.NETSUIT_RESTLET_VB_URL
        : process.env.NETSUIT_RESTLET_VC_URL;

    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: endpoiont,
      method: 'POST',
    };

    const authHeader = getAuthorizationHeader(options);

    const configApi = {
      method: options.method,
      maxBodyLength: Infinity,
      url: options.url,
      headers: {
        'Content-Type': 'application/json',
        ...authHeader,
      },
      data: JSON.stringify(payload),
    };

    const response = await axios.request(configApi);

    if (response.status === 200 && response.data.status === 'Success') {
      return response.data.id;
    } else {
      throw {
        customError: true,
        msg: response.data.reason.replace(/'/g, '`'),
        payload: JSON.stringify(payload),
        response: response.data,
      };
    }
  } catch (error) {
    console.error("error:createInvoice:main:catch", error);
    if (error?.response?.reason) {
      throw {
        customError: true,
        msg: error.msg.replace(/'/g, '`'),
        payload: error.payload,
        response: JSON.stringify(error.response).replace(/'/g, '`'),
      };
    } else {
      throw {
        customError: true,
        msg: 'Netsuit AP API Failed',
        response: '',
      };
    }
  }
}


function makeLineItemsJsonPayload(invoiceId, data) {
  try {
    const hardcode = getHardcodeData();

    /**
     * head level details
     */
    const payload = {
      id: invoiceId,
      item: data.map((e) => {
        return {
          // custcol_mfc_line_unique_key:"",
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
    };
    return payload;
  } catch (error) {
    console.info("error payload", error);
  }
}

function createInvoiceAndUpdateLineItems(invoiceId, data) {
  return new Promise((resolve, reject) => {
    try {
      const endpoiont =
        data[0].invoice_type == "IN"
          ? process.env.NETSUIT_RESTLET_VB_URL
          : process.env.NETSUIT_RESTLET_VC_URL;
      const options = {
        consumer_key: userConfig.token.consumer_key,
        consumer_secret_key: userConfig.token.consumer_secret,
        token: userConfig.token.token_key,
        token_secret: userConfig.token.token_secret,
        realm: userConfig.account,
        url: endpoiont,
        method: "PUT",
      };
      const authHeader = getAuthorizationHeader(options);

      const payload = makeLineItemsJsonPayload(invoiceId, data);

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

      axios
        .request(configApi)
        .then((response) => {
          console.info(JSON.stringify(response.data));
          if (response.status === 200 && response.data.status === "Success") {
            resolve(response.data.id);
          } else {
            reject({
              customError: true,
              msg: response.data.reason.replace(/'/g, "`"),
              payload: JSON.stringify(payload),
              response: JSON.stringify(response.data).replace(/'/g, "`"),
            });
          }
        })
        .catch((error) => {
          console.error(error.response.data);
          reject({
            customError: true,
            msg: error.response.data.reason.replace(/'/g, "`"),
            payload: JSON.stringify(payload),
            response: JSON.stringify(error.response.data).replace(/'/g, "`"),
          });
        });
    } catch (error) {
      console.error("error:createInvoice:main:catch", error);
      reject({
        customError: true,
        msg: "Netsuit AP Api Failed",
        response: "",
      });
    }
  });
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
    let query = `UPDATE ${apDbName} `;
    if (isSuccess) {
      query += ` SET internal_id = '${invoiceId}', processed = 'P', `;
    } else {
      query += ` SET internal_id = null, processed = 'F', `;
    }
    query += ` processed_date = '${today}'  
                WHERE source_system = '${source_system}' and 
                      invoice_nbr = '${item.invoice_nbr}' and 
                      invoice_type = '${item.invoice_type}'and 
                      vendor_id = '${item.vendor_id}'`;
    console.info("query", query)
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
      console.error("error:updateInvoiceId", error);
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
  try {
    const date = new Date(param);
    return (
      date.getFullYear() +
      "-" +
      ("00" + (date.getMonth() + 1)).slice(-2) +
      "-" +
      ("00" + date.getDate()).slice(-2) +
      "T11:05:03.000Z"
    );
  } catch (error) {
    return null;
  }
}

function getCustomDate() {
  const date = new Date();
  let ye = new Intl.DateTimeFormat("en", { year: "numeric" }).format(date);
  let mo = new Intl.DateTimeFormat("en", { month: "2-digit" }).format(date);
  let da = new Intl.DateTimeFormat("en", { day: "2-digit" }).format(date);
  return `${ye}-${mo}-${da}`;
}
