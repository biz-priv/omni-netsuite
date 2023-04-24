const AWS = require("aws-sdk");
const moment = require("moment");
const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");
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
    TMS: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        // consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        // consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        // token_key: env.NETSUIT_MCL_TOKEN_KEY,
        // token_secret: env.NETSUIT_MCL_TOKEN_SECRET,
        consumer_key:
          "9199a46736cf74115dd8386d88cca574bcadb512938b356608b5467134242058",
        consumer_secret:
          "110d6c1a46443ae2a6457ede5f2370b8b9bbb9940da258f33de17c583ed76f29",
        token_key:
          "64c75fcd6f0d1b2c3fd3c7a019bdd2ff538491181e372d08f64234e4af035eb6",
        token_secret:
          "6bd2ec556dc6de9fec72128aea46c21c9673d6714038e43d432a5b47404f6b1e",
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

async function getConnectionToRds(env) {
  try {
    const dbUser = env.db_username;
    const dbPassword = env.db_password;
    // const dbHost = env.db_host
    const dbHost =
      "db-replication-instance-1.csqnwcsrz7o6.us-east-1.rds.amazonaws.com";
    const dbPort = env.db_port;
    const dbName = env.db_name;
    const connection = await mysql.createConnection({
      host: dbHost,
      user: dbUser,
      password: dbPassword,
      database: dbName,
      port: dbPort,
    });
    return connection;
  } catch (error) {
    console.error(error);
  }
}

/**
 * handle error logs AR
 */
async function createARFailedRecords(
  connections,
  item,
  error,
  dbType = "redshift",
  arDbNamePrev = null
) {
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
    const dbPrev = arDbNamePrev != null ? arDbNamePrev : "";
    const query = `INSERT INTO ${dbPrev}interface_ar_api_logs (${tableStr}) VALUES (${valueStr});`;
    // console.log("query", query);
    if (dbType === "redshift") {
      await connections.query(query);
    } else {
      await connections.execute(query);
    }
  } catch (error) {
    console.log("createARFailedRecords:error", error);
  }
}

/**
 * handle error logs AP
 */
async function createAPFailedRecords(
  connections,
  item,
  error,
  dbType = "redshift",
  arDbNamePrev = null
) {
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
    const dbPrev = arDbNamePrev != null ? arDbNamePrev : "";
    const query = `INSERT INTO ${dbPrev}interface_ap_api_logs (${tableStr}) VALUES (${valueStr});`;
    // console.log("query", query);
    if (dbType === "redshift") {
      await connections.query(query);
    } else {
      await connections.execute(query);
    }
  } catch (error) {
    console.log("createAPFailedRecords:error", error);
  }
}

/**
 * handle error logs Intercompany
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
    console.log("functionName", functionName);
    console.log("payloadData", payloadData);
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

function sendDevNotification(
  sourceSystem,
  invType,
  apiName,
  invoiceData,
  error
) {
  return new Promise((resolve, reject) => {
    try {
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
        // to: process.env.NETSUIT_AR_ERROR_EMAIL_TO,
        to: "kazi.ali@bizcloudexperts.com,priyanka@bizcloudexperts.com,mish@bizcloudexperts.com,ashish.akshantal@bizcloudexperts.com",
        subject: `Netsuite DEV Error ${sourceSystem} - ${invType} - ${process.env.STAGE.toUpperCase()}`,
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
          <h3>Error:- ${sourceSystem} - ${invType} - ${apiName} </h3>

          <p> Source System:- ${sourceSystem ?? ""}</p> 
          <p> Invoice Type:- ${invType ?? ""}</p> 
          <p> Invoice Data:- </p> <pre>${JSON.stringify(
            invoiceData,
            null,
            4
          )}</pre>
          <p> Error:- </p> <pre>${JSON.stringify(error, null, 4)}</pre>
        </body>
        </html>
        `,
      };
      transporter.sendMail(message, function (err, info) {
        resolve(true);
      });
      resolve(true);
    } catch (error) {
      resolve(false);
    }
  });
}

module.exports = {
  getConfig,
  getConnection,
  getConnectionToRds,
  createARFailedRecords,
  createAPFailedRecords,
  createIntercompanyFailedRecords,
  triggerReportLambda,
  sendDevNotification,
};
