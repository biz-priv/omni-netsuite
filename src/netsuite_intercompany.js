const AWS = require("aws-sdk");
const axios = require("axios");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true, noLocking: false });
const nodemailer = require("nodemailer");
const {
  getConnection,
  createIntercompanyFailedRecords,
  triggerReportLambda,
  sendDevNotification,
} = require("../Helpers/helper");

const userConfig = {
  account: process.env.NETSUIT_AR_ACCOUNT,
  apiVersion: "2021_2",
  realm: process.env.NETSUIT_AR_ACCOUNT,
  signature_method: "HMAC-SHA256",
  token: {
    consumer_key: process.env.NETSUIT_AR_CONSUMER_KEY,
    consumer_secret: process.env.NETSUIT_AR_CONSUMER_SECRET,
    token_key: process.env.NETSUIT_AR_TOKEN_KEY,
    token_secret: process.env.NETSUIT_AR_TOKEN_SECRET,
  },
};
const today = getCustomDate();
const totalCountPerLoop = 5;
const source_system = "CW";
const arDbName = "interface_ar_cw";
const apMasterDbName = "interface_ap_master_cw";
const apDbName = "interface_ap_cw";

module.exports.handler = async (event, context, callback) => {
  const checkIsRunning = await checkOldProcessIsRunning();
  if (checkIsRunning) {
    return {
      hasMoreData: "false",
    };
  }

  let hasMoreData = "false";
  let currentCount = 0;
  try {
    /**
     * Get connections
     */
    const connections = dbc(getConnection(process.env));
    /**
     * Get invoice internal ids from ${apDbName} and ${arDbName}
     */
    const invoiceData = await getData(connections);
    console.log("invoiceData", invoiceData.length);
    currentCount = invoiceData.length;

    for (let i = 0; i < invoiceData.length; i++) {
      const item = invoiceData[i];
      console.log("item", item);
      await mainProcess(connections, item);
      console.log("count", i + 1);
    }

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
      await triggerReportLambda(
        process.env.NETSUIT_INVOICE_REPORT,
        "CW_INTERCOMPANY"
      );
      hasMoreData = "false";
    }
    dbc.end();
    return { hasMoreData };
  } catch (error) {
    console.log("error:handler", error);
    dbc.end();
    await triggerReportLambda(
      process.env.NETSUIT_INVOICE_REPORT,
      "CW_INTERCOMPANY"
    );
    return { hasMoreData: "false" };
  }
};

/**
 * get data
 * @param {*} connections
 */
async function getData(connections) {
  try {
    const query = `
          select distinct ar.source_system , ar.file_nbr , ar.ar_internal_id , ap.ap_internal_id, ap.invoice_type
          from (select distinct source_system ,file_nbr ,invoice_nbr ,invoice_type ,unique_ref_nbr,internal_id as ar_internal_id ,total 
              from ${arDbName} ia
                where source_system = '${source_system}' and intercompany = 'Y' and pairing_available_flag = 'Y' and processed = 'P' and (intercompany_processed_date is null or 
                  (intercompany_processed = 'F' and intercompany_processed_date < '${today}'))
              )ar
          join
              (
                  select distinct a.source_system ,a.file_nbr ,a.invoice_nbr ,a.invoice_type ,a.unique_ref_nbr ,b.internal_id as ap_internal_id,total 
                  from ( select * from ${apDbName} where intercompany = 'Y' and pairing_available_flag = 'Y' and source_system = '${source_system}')a
                  join (select * from ${apMasterDbName} 
                          where source_system = '${source_system}' and intercompany = 'Y' and pairing_available_flag = 'Y' and processed = 'P' and (intercompany_processed_date is null or 
                              (intercompany_processed = 'F' and intercompany_processed_date < '${today}'))
                  )b
                  on a.source_system = b.source_system
                  and a.file_nbr = b.file_nbr
                  and a.invoice_nbr = b.invoice_nbr
                  and a.invoice_type = b.invoice_type
                  and a.vendor_id = b.vendor_id
              )ap
          on ar.source_system = ap.source_system
          and ar.file_nbr = ap.file_nbr
          and ar.invoice_type = ap.invoice_type
          and ar.unique_ref_nbr = ap.unique_ref_nbr
          limit ${totalCountPerLoop + 1}`;
    const result = await connections.query(query);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.log("error:getData", error);
    throw "No data found.";
  }
}

/**
 * Update data
 * @param {*} connections
 * @param {*} item
 */
async function updateAPandAr(connections, item, processed = "P") {
  try {
    console.log(
      "updateAPandAr",
      "AP " + item.ap_internal_id,
      "AR " + item.ar_internal_id,
      processed
    );
    const query1 = `
                UPDATE ${apMasterDbName} set 
                intercompany_processed = '${processed}', 
                intercompany_processed_date = '${today}'
                where internal_id = '${item.ap_internal_id}' and source_system = '${source_system}';
                `;
    console.log("query1", query1);
    await connections.query(query1);
    const query2 = `
                UPDATE ${arDbName} set 
                intercompany_processed = '${processed}', 
                intercompany_processed_date = '${today}'
                where internal_id = '${item.ar_internal_id}' and source_system = '${source_system}';
              `;
    console.log("query2", query2);
    await connections.query(query2);
  } catch (error) {
    console.log("error:updateAPandAr", error);
    await sendDevNotification(
      "INVOICE-INTERCOMPANY",
      "CW",
      "netsuite_intercompany updateAPandAr",
      item,
      error
    );
  }
}

async function mainProcess(connections, item) {
  try {
    await createInterCompanyInvoice(item);
    await updateAPandAr(connections, item);
  } catch (error) {
    console.log("error:mainProcess", error);
    if (error.hasOwnProperty("customError")) {
      await updateAPandAr(connections, item, "F");
      await createIntercompanyFailedRecords(connections, item, error);
      // await sendMail(error);
    } else {
      await sendDevNotification(
        "INVOICE-INTERCOMPANY",
        "CW",
        "netsuite_intercompany mainProcess",
        item,
        error
      );
    }
  }
}

async function createInterCompanyInvoice(item) {
  const apInvoiceId = item.ap_internal_id;
  const arInvoiceId = item.ar_internal_id;
  const transactionType = item.invoice_type == "IN" ? "invoice" : "creditmemo";
  try {
    const baseUrl = process.env.NETSUITE_INTERCOMPANY_BASE_URL;
    const url = `${baseUrl}&iid1=${arInvoiceId}&iid2=${apInvoiceId}&transactionType=${transactionType}`;
    const authHeader = getAuthorizationHeader(url);
    const headers = {
      ...authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const res = await axios.get(url, { headers });
    if (res.data == "success") {
      return true;
    } else {
      throw {
        data: res.data,
      };
    }
  } catch (error) {
    console.log("error:createInterCompanyInvoice", error);
    throw {
      customError: true,
      arInvoiceId,
      apInvoiceId,
      transactionType,
      data: error?.data ?? error?.response?.data,
    };
  }
}

function getAuthorizationHeader(url) {
  try {
    const oauth = OAuth({
      consumer: {
        key: userConfig.token.consumer_key,
        secret: userConfig.token.consumer_secret,
      },
      realm: userConfig.realm,
      signature_method: userConfig.signature_method,
      hash_function: (base_string, key) =>
        crypto.createHmac("sha256", key).update(base_string).digest("base64"),
    });
    return oauth.toHeader(
      oauth.authorize(
        {
          url: url,
          method: "get",
        },
        {
          key: userConfig.token.token_key,
          secret: userConfig.token.token_secret,
        }
      )
    );
  } catch (error) {
    throw error;
  }
}

function sendMail(data) {
  return {};
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
        to: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
        // to: "kazi.ali@bizcloudexperts.com,kiranv@bizcloudexperts.com,priyanka@bizcloudexperts.com,wwaller@omnilogistics.com,psotelo@omnilogistics.com,vbibi@omnilogistics.com",
        // to: "kazi.ali@bizcloudexperts.com",
        subject: `Netsuite CW Intercompany ${process.env.STAGE.toUpperCase()} Invoices - Error`,
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
          <h3>Error msg:- ${data?.data?.error?.message ?? ""} </h3>
          <p> Error Obj:- </p> <pre> ${JSON.stringify(data, null, 4)} </pre>
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
      console.log("mail:error", error);
      resolve(true);
    }
  });
}

function getCustomDate() {
  const date = new Date();
  let ye = new Intl.DateTimeFormat("en", { year: "numeric" }).format(date);
  let mo = new Intl.DateTimeFormat("en", { month: "2-digit" }).format(date);
  let da = new Intl.DateTimeFormat("en", { day: "2-digit" }).format(date);
  return `${ye}-${mo}-${da}`;
}

async function checkOldProcessIsRunning() {
  return new Promise((resolve, reject) => {
    try {
      //intercompant arn
      const intercompany = process.env.NETSUITE_INTERCOMPANY_ARN;
      const status = "RUNNING";
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.listExecutions(
        {
          stateMachineArn: intercompany,
          statusFilter: status,
          maxResults: 2,
        },
        (err, data) => {
          console.log(" Intercompany listExecutions data", data);
          const venExcList = data.executions;
          if (
            err === null &&
            venExcList.length == 2 &&
            venExcList[1].status === status
          ) {
            console.log("Intercompany running");
            resolve(true);
          } else {
            resolve(false);
          }
        }
      );
    } catch (error) {
      resolve(true);
    }
  });
}
