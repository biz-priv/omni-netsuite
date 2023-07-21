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
const source_system = "CW";
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
      // await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "CW_AR");
      hasMoreData = "false";
    }
    dbc.end();
    return { hasMoreData };
  } catch (error) {
    dbc.end();
    // await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "CW_AR");
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
    // console.log("singleItem", singleItem);

    /**
     * Make Json payload
     */
    const jsonPayload = await makeJsonPayload(dataList);
    

    /**
     * create Netsuit Invoice
     */
    const invoiceId = await createInvoice(jsonPayload, singleItem);
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
    const query = `SELECT distinct invoice_nbr,customer_id,invoice_type, gc_code FROM ${arDbNamePrev}interface_ar
    where source_system = '${source_system}' and customer_internal_id is not null and invoice_nbr is not null
    and internal_id is null and (processed='F' or processed is null or processed_date < '${today}')
    and ((intercompany='Y' and pairing_available_flag ='Y') or intercompany='N')
    order by invoice_nbr,customer_id,invoice_type, gc_code
    limit ${totalCountPerLoop + 1}`;
                 

    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.log("error",error);
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
    const hardcode = getHardcodeData(
      singleItem.intercompany == "Y" ? true : false
    );

    /**
     * head level details
     */
    const payload = {
      custbody_mfc_omni_unique_key:
        singleItem.invoice_nbr + "-" + singleItem.invoice_type, //invoice_nbr, invoice_type
      tranid: singleItem.invoice_nbr ?? "",
      trandate: singleItem.invoice_date
        ? dateFormat(singleItem.invoice_date)
        : null,
      department: hardcode.department.head,
      class: hardcode.class.head,
      location: hardcode.location.head,
      custbody_source_system: hardcode.source_system,//2327
      entity: singleItem.customer_internal_id ?? "",
      subsidiary: singleItem.subsidiary ?? "",
      currency: singleItem.currency_internal_id ?? "",
      otherrefnum: singleItem.file_nbr ?? "",
      custbody_mode: singleItem?.mode_name ?? "",//2673
      custbody_service_level: singleItem?.service_level ?? "",//2674
      custbody18: singleItem.finalized_date ?? "",//1745
      custbody9: singleItem.housebill_nbr ?? "",//1730 //here in soap we are passing file_nbr
      custbody17: singleItem.email ?? "",//1744
      custbody25: singleItem.zip_code ?? "",//2698
      custbody19: singleItem.unique_ref_nbr ?? "",//1734
      item: data.map((e) => {
        return {
          // custcol_mfc_line_unique_key:"",
          item: e.charge_cd_internal_id ?? "",
          taxcode: e?.tax_code_internal_id ?? "",
          description: e?.charge_cd_desc ?? "",
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
          custcol_hawb: e.housebill_nbr ?? "",//760
          custcol3: e.sales_person ?? "",//1167
          custcol5: e.master_bill_nbr ?? "",//1727
          custcol2: {
            refName: e.controlling_stn ?? "",//1166
          },
          custcol1: e.ready_date ? e.ready_date.toISOString() : "",//1164
        };
      }),
    };

    console.log("payload", JSON.stringify(payload));
    return payload;
  } catch (error) {
    console.log("error payload", error);
    await sendDevNotification(
      source_system,
      "AR",
      "netsuite_ar_cw payload error",
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

// function createInvoice(payload, singleItem) {
//   return new Promise((resolve, reject) => {
//     try {
//       const invTypeEndpoiont =
//         singleItem.invoice_type == "IN"
//           ? "customdeploy_mfc_rl_mcleod_inv"
//           : "customdeploy_mfc_rl_mcleod_cm";
//       const options = {
//         consumer_key: userConfig.token.consumer_key,
//         consumer_secret_key: userConfig.token.consumer_secret,
//         token: userConfig.token.token_key,
//         token_secret: userConfig.token.token_secret,
//         realm: userConfig.account,
//         url: `https://${userConfig.account
//           .toLowerCase()
//           .split("_")
//           .join(
//             "-"
//           )}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_mfc_rl_mcleod&deploy=${invTypeEndpoiont}`,
//         method: "POST",
//       };
//       const authHeader = getAuthorizationHeader(options);

//       const configApi = {
//         method: options.method,
//         maxBodyLength: Infinity,
//         url: options.url,
//         headers: {
//           "Content-Type": "application/json",
//           ...authHeader,
//         },
//         data: JSON.stringify(payload),
//       };
//       console.log("configApi", configApi);

//       axios
//         .request(configApi)
//         .then((response) => {
//           console.log("response", response.status);
//           console.log(JSON.stringify(response.data));
//           if (response.status === 200 && response.data.status === "Success") {
//             resolve(response.data.id);
//           } else {
//             reject({
//               customError: true,
//               msg: response.data.reason.replace(/'/g, "`"),
//               payload: JSON.stringify(payload),
//               response: JSON.stringify(response.data).replace(/'/g, "`"),
//             });
//           }
//         })
//         .catch((error) => {
//           console.log(error.response.status);
//           console.log(error.response.data);
//           reject({
//             customError: true,
//             msg: error.response.data.reason.replace(/'/g, "`"),
//             payload: JSON.stringify(payload),
//             response: JSON.stringify(error.response.data).replace(/'/g, "`"),
//           });
//         });
//     } catch (error) {
//       console.log("error:createInvoice:main:catch", error);
//       reject({
//         customError: true,
//         msg: "Netsuit AR Api Failed",
//         response: "",
//       });
//     }
//   });
// }


async function createInvoice(payload, singleItem) {
  try {
    const invTypeEndpoint =
      singleItem.invoice_type == 'IN'
        ? 'customdeploy_mfc_rl_mcleod_inv'
        : 'customdeploy_mfc_rl_mcleod_cm';

    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: `https://${userConfig.account
        .toLowerCase()
        .split('_')
        .join('-')}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_mfc_rl_mcleod&deploy=${invTypeEndpoint}`,
      method: 'POST',
    };

    const authHeader = await getAuthorizationHeader(options);

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

    console.log('configApi', configApi);

    const response = await axios.request(configApi);

    if (response.status === 200 && response.data.status === 'Success') {
      return response.data.id;
    } else {
      throw {
        customError: true,
        msg: response.data.reason.replace(/'/g, '`'),
        payload: JSON.stringify(payload),
        response: JSON.stringify(response.data).replace(/'/g, '`'),
      };
    }
  } catch (error) {
    console.log("createInvoice:error",error);
    if (error.response) {
      throw {
        customError: true,
        msg: error.msg.replace(/'/g, '`'),
        payload: error.payload,
        response: error.response.replace(/'/g, '`'),
      };
    } else {
      throw {
        customError: true,
        msg: 'Netsuit AR Api Failed',
        response: '',
      };
    }
  }
}




function getUpdateQuery(item, invoiceId, isSuccess = true) {
  try {
    console.log("invoice_nbr ", item.invoice_nbr, invoiceId);
    let query = `UPDATE ${arDbName} `;
    if (isSuccess) {
      query += ` SET internal_id = '${invoiceId}', processed = 'P', `;
    } else {
      query += ` SET internal_id = null, processed = 'F', `;
    }
    query += `processed_date = '${today}' 
              WHERE source_system = '${source_system}' and invoice_nbr = '${item.invoice_nbr}' 
              and invoice_type = '${item.invoice_type}';`;
    console.log("query", query);
    return query;
  } catch (error) {
    console.log("error:getUpdateQuery", error, item, invoiceId);
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
        "netsuite_ar_cw updateInvoiceId",
        "Invoice is created But failed to update internal_id " + element,
        error
      );
    }
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
  }
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
