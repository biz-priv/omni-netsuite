const moment = require("moment");
const AWS = require("aws-sdk");
const lambda = new AWS.Lambda();

/**
 * Config for Netsuite
 * @param {*} source_system
 * @param {*} env
 * @returns
 */
function getConfig(source_system, env) {
  const data = {
    WT: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_AR_TOKEN_KEY,
        token_secret: env.NETSUIT_AR_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    },
    CW: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_CW_TOKEN_KEY,
        token_secret: env.NETSUIT_CW_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    },
    M1: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_M1_TOKEN_KEY,
        token_secret: env.NETSUIT_M1_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    },
    TR: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_TR_TOKEN_KEY,
        token_secret: env.NETSUIT_TR_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    },
  };
  return data[source_system];
}

/**
 * Config for connections
 * @param {*} env
 * @returns
 */
function getConnection(env) {
  try {
    const dbUser = env.USER;
    const dbPassword = env.PASS;
    const dbHost = env.HOST;
    // const dbHost = "omni-dw-prod.cnimhrgrtodg.us-east-1.redshift.amazonaws.com";
    const dbPort = env.PORT;
    const dbName = env.DBNAME;

    const connectionString = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;
    return connectionString;
  } catch (error) {
    throw "DB Connection Error";
  }
}

/**
 * handle error logs AR
 */
async function createARFailedRecords(connections, item, error) {
  try {
    const formatData = {
      source_system: item?.source_system ?? null,
      file_nbr: item?.file_nbr ?? null,
      customer_id: item?.customer_id ?? null,
      subsidiary: item?.subsidiary ?? null,
      invoice_nbr: item?.invoice_nbr ?? null,
      invoice_date:
        item?.invoice_date && moment(item?.invoice_date).isValid()
          ? moment(item?.invoice_date).format("YYYY-MM-DD HH:mm:ss")
          : null,
      housebill_nbr: item?.housebill_nbr ?? null,
      master_bill_nbr: item?.master_bill_nbr ?? null,
      invoice_type: item?.invoice_type ?? null,
      controlling_stn: item?.controlling_stn ?? null,
      charge_cd: item?.charge_cd ?? null,
      total: item?.total ?? null,
      curr_cd: item?.curr_cd ?? null,
      posted_date:
        item?.posted_date && moment(item?.posted_date).isValid()
          ? moment(item?.posted_date).format("YYYY-MM-DD HH:mm:ss")
          : null,
      gc_code: item?.gc_code ?? null,
      tax_code: item?.tax_code ?? null,
      unique_ref_nbr: item?.unique_ref_nbr ?? null,
      internal_ref_nbr: item?.internal_ref_nbr ?? null,
      order_ref: item?.order_ref ?? null,
      ee_invoice: item?.ee_invoice ?? null,
      intercompany: item?.intercompany ?? null,
      error_msg: error?.msg + " Subsidiary: " + item?.subsidiary,
      payload: null,
      response: error?.response ?? null,
      is_report_sent: "N",
      current_dt: moment().format("YYYY-MM-DD"),
    };
    // console.log("formatData", formatData);

    let tableStr = "";
    let valueStr = "";
    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");

    console.log("tableStr", tableStr);
    console.log("valueStr", valueStr);

    const query = `INSERT INTO interface_ar_api_logs (${tableStr}) VALUES (${valueStr});`;
    // console.log("query", query);
    await connections.query(query);
  } catch (error) {
    console.log("createARFailedRecords:error", error);
  }
}

/**
 * handle error logs AP
 */
async function createAPFailedRecords(connections, item, error) {
  try {
    const formatData = {
      source_system: item?.source_system ?? null,
      file_nbr: item?.file_nbr ?? null,
      vendor_id: item?.vendor_id ?? null,
      subsidiary: item?.subsidiary ?? null,
      invoice_nbr: item?.invoice_nbr ?? null,
      invoice_date:
        item?.invoice_date && moment(item?.invoice_date).isValid()
          ? moment(item?.invoice_date).format("YYYY-MM-DD HH:mm:ss")
          : null,
      housebill_nbr: item?.housebill_nbr ?? null,
      master_bill_nbr: item.master_bill_nbr ?? null,
      invoice_type: item?.invoice_type ?? null,
      controlling_stn: item.controlling_stn ?? null,
      currency: item?.currency ?? null,
      charge_cd: item?.charge_cd ?? null,
      total: item?.total ?? null,
      posted_date:
        item?.posted_date && moment(item?.posted_date).isValid()
          ? moment(item?.posted_date).format("YYYY-MM-DD HH:mm:ss")
          : null,
      gc_code: item.gc_code ?? null,
      tax_code: item.tax_code ?? null,
      unique_ref_nbr: item.unique_ref_nbr ?? null,
      internal_ref_nbr: item.internal_ref_nbr ?? null,
      intercompany: item?.intercompany ?? null,
      error_msg: error?.msg + " Subsidiary: " + item.subsidiary,
      payload: null,
      response: error?.response ?? null,
      is_report_sent: "N",
      current_dt: moment().format("YYYY-MM-DD"),
    };
    // console.log("formatData", formatData);

    let tableStr = "";
    let valueStr = "";
    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");

    console.log("tableStr", tableStr);
    console.log("valueStr", valueStr);

    const query = `INSERT INTO interface_ap_api_logs (${tableStr}) VALUES (${valueStr});`;
    // console.log("query", query);
    await connections.query(query);
  } catch (error) {
    console.log("createAPFailedRecords:error", error);
  }
}

/**
 * handle error logs AP
 */
async function createIntercompanyFailedRecords(connections, item, error) {
  try {
    const formatData = {
      source_system: item.source_system,
      invoice_type: item.invoice_type,
      file_nbr: item.file_nbr,
      ar_internal_id: item.ar_internal_id,
      ap_internal_id: item.ap_internal_id,
      error_msg: error.data.error.message,
      is_report_sent: "N",
      current_dt: moment().format("YYYY-MM-DD"),
    };
    console.log("formatData", formatData);

    let tableStr = "";
    let valueStr = "";
    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");

    const query = `INSERT INTO interface_intercompany_api_logs (${tableStr}) VALUES (${valueStr});`;
    console.log("query", query);
    await connections.query(query);
  } catch (error) {
    console.log("createIntercompanyFailedRecords:error", error);
  }
}

/**
 * send report lambda trigger function
 */
function triggerReportLambda(functionName, payloadData) {
  return new Promise((resolve, reject) => {
    try {
      lambda.invoke(
        {
          FunctionName: functionName,
          Payload: JSON.stringify({ invPayload: payloadData }, null, 2),
        },
        function (error, data) {
          if (error) {
            console.log("error: unable to send report", error);
            resolve("failed");
          }
          if (data.Payload) {
            console.log(data.Payload);
            resolve("success");
          }
        }
      );
    } catch (error) {
      console.log("error:triggerReportLambda", error);
      console.log("unable to send report");
      resolve("failed");
    }
  });
}

module.exports = {
  getConfig,
  getConnection,
  createARFailedRecords,
  createAPFailedRecords,
  createIntercompanyFailedRecords,
  triggerReportLambda,
};
