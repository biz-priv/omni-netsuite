const AWS = require("aws-sdk");
const nodemailer = require("nodemailer");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const NetSuite = require("node-suitetalk");
const { getConfig, getConnection } = require("../../Helpers/helper");
const Configuration = NetSuite.Configuration;
const Service = NetSuite.Service;
const Search = NetSuite.Search;

let userConfig = "";

let totalCountPerLoop = 10;
const today = getCustomDate();
const source_system = "WT";

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);
  const checkIsRunning = await checkOldProcessIsRunning();
  if (checkIsRunning) {
    return {
      hasMoreData: "false",
    };
  }
  let hasMoreData = "false";
  let currentCount = 0;
  totalCountPerLoop = event.hasOwnProperty("totalCountPerLoop")
    ? event.totalCountPerLoop
    : totalCountPerLoop;
  try {
    /**
     * Get connections
     */
    const connections = dbc(getConnection(process.env));

    /**
     * Get data from db
     */
    const vendorList = await getVendorData(connections);
    console.log("vendorList", vendorList.length);
    currentCount = vendorList.length;

    for (let i = 0; i < vendorList.length; i++) {
      const vendor_id = vendorList[i].vendor_id;
      try {
        /**
         * get vendor from netsuit
         */
        const vendorData = await getVendor(vendor_id);

        /**
         * Update vendor details into DB
         */
        await putVendor(connections, vendorData, vendor_id);
        console.log("count", i + 1);
      } catch (error) {
        try {
          if (error.hasOwnProperty("customError")) {
            /**
             * update error
             */
            const singleItem = await getDataByVendorId(connections, vendor_id);
            await updateFailedRecords(connections, vendor_id);
            /**
             * check if same error from dynamo db
             * true if already notification sent
             * false if it is new
             */
            const checkError = await checkSameError(singleItem);
            if (!checkError) {
              await recordErrorResponse(singleItem, error);
            }
          }
        } catch (error) {}
      }
    }

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
      hasMoreData = "false";
    }
  } catch (error) {
    hasMoreData = "false";
  }

  if (hasMoreData == "false") {
    try {
      await startNetsuitInvoiceStep();
    } catch (error) {}
    dbc.end();
    return { hasMoreData };
  } else {
    dbc.end();
    return { hasMoreData };
  }
};

async function checkOldProcessIsRunning() {
  return new Promise((resolve, reject) => {
    try {
      //WT AP vendor
      const vendorArn = process.env.NETSUITE_AP_WT_VENDOR_STEP_ARN;
      //WT AP
      const wtApArn = process.env.NETSUITE_AP_WT_STEP_ARN;

      const status = "RUNNING";
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.listExecutions(
        {
          stateMachineArn: vendorArn,
          statusFilter: status,
          maxResults: 2,
        },
        (err, data) => {
          console.log(" vendorArn listExecutions data", data);
          const venExcList = data.executions;
          if (
            err === null &&
            venExcList.length == 2 &&
            venExcList[1].status === status
          ) {
            console.log("vendorArn running");
            resolve(true);
          } else {
            stepfunctions.listExecutions(
              {
                stateMachineArn: wtApArn,
                statusFilter: status,
                maxResults: 1,
              },
              (err, data) => {
                console.log(" wtApArn listExecutions data", data);
                const wtapExcList = data.executions;
                if (
                  err === null &&
                  wtapExcList.length > 0 &&
                  wtapExcList[0].status === status
                ) {
                  console.log("wtApArn running");
                  resolve(true);
                } else {
                  resolve(false);
                }
              }
            );
          }
        }
      );
    } catch (error) {
      resolve(true);
    }
  });
}

async function getVendorData(connections) {
  try {
    const query = `SELECT distinct vendor_id FROM interface_ap_master 
                    where ((vendor_internal_id = '' and processed_date is null) or
                            (vendor_internal_id = '' and processed_date < '${today}'))
                          and source_system = '${source_system}' 
                    limit ${totalCountPerLoop + 1}`;
    console.log("query", query);
    const result = await connections.query(query);
    if (!result || result.length == 0) {
      throw "No data found";
    }
    return result;
  } catch (error) {
    throw "getVendorData: No data found.";
  }
}

async function getDataByVendorId(connections, vendor_id) {
  try {
    const query = `SELECT * FROM interface_ap_master where source_system = '${source_system}' and
                    vendor_id = '${vendor_id}' limit 1`;
    const result = await connections.query(query);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result[0];
  } catch (error) {
    throw "getDataByVendorId: No data found.";
  }
}

async function putVendor(connections, vendorData, vendor_id) {
  try {
    let query = `INSERT INTO netsuit_vendors (vendor_id, vendor_internal_id, curr_cd, currency_internal_id)
                  VALUES ('${vendorData.entityId}', '${vendorData.entityInternalId}','','');`;
    query += `UPDATE interface_ap_master SET 
                    processed = '',
                    vendor_internal_id = '${vendorData.entityInternalId}', 
                    processed_date = '${today}' 
                    WHERE vendor_id = '${vendor_id}' and source_system = '${source_system}' and vendor_internal_id = '';`;
    await connections.query(query);
  } catch (error) {
    throw "Vendor Update Failed";
  }
}

function getVendor(entityId) {
  return new Promise((resolve, reject) => {
    const config = new Configuration(userConfig);
    const service = new Service(config);
    service
      .init()
      .then((/**/) => {
        // Set search preferences
        const searchPreferences = new Search.SearchPreferences();
        searchPreferences.pageSize = 50;
        service.setSearchPreferences(searchPreferences);

        // Create basic search
        const search = new Search.Basic.CustomerSearchBasic();
        search._name = "VendorSearchBasic";

        const nameStringField = new Search.Fields.SearchStringField();
        nameStringField.field = "entityId";
        nameStringField.operator = "is";
        nameStringField.searchValue = entityId;

        search.searchFields.push(nameStringField);

        return service.search(search);
      })
      .then((result, raw, soapHeader) => {
        if (result && result?.searchResult?.recordList?.record.length > 0) {
          const recordList = result.searchResult.recordList.record;
          let record = recordList.filter(
            (e) => e.entityId.toUpperCase() == entityId.toUpperCase()
          );
          if (record.length > 0) {
            record = record[0];
            resolve({
              entityId: record.entityId,
              entityInternalId: record["$attributes"].internalId,
            });
          } else {
            reject({
              customError: true,
              msg: `Vendor not found. (vendor_id: ${entityId})`,
            });
          }
        } else {
          reject({
            customError: true,
            msg: `Vendor not found. (vendor_id: ${entityId})`,
          });
        }
      })
      .catch((err) => {
        reject({
          customError: false,
          msg: `Vendor Api failed. (vendor_id: ${entityId})`,
        });
      });
  });
}

async function updateFailedRecords(connections, vendor_id) {
  try {
    let query = `UPDATE interface_ap_master SET 
                  processed = 'F',
                  processed_date = '${today}' 
                  WHERE vendor_id = '${vendor_id}' and source_system = '${source_system}' and vendor_internal_id = '';`;
    const result = await connections.query(query);
    return result;
  } catch (error) {}
}

async function recordErrorResponse(item, error) {
  try {
    let documentClient = new AWS.DynamoDB.DocumentClient({
      region: process.env.REGION,
    });
    const data = {
      id: item.invoice_nbr + item.invoice_type,
      invoice_nbr: item.invoice_nbr,
      vendor_id: item.vendor_id,
      invoice_type: item.invoice_type,
      errorDescription: error?.msg,
      payload: error?.payload,
      response: error?.response,
      status: "error",
      created_at: new Date().toLocaleString(),
    };
    const params = {
      TableName: process.env.NETSUIT_AP_ERROR_TABLE,
      Item: data,
    };
    await documentClient.put(params).promise();
    await sendMail(data);
  } catch (e) {}
}

function sendMail(data) {
  return new Promise((resolve, reject) => {
    try {
      let errorObj = JSON.parse(JSON.stringify(data));
      delete errorObj["payload"];
      delete errorObj["response"];

      const transporter = nodemailer.createTransport({
        host: process.env.NETSUIT_AR_ERROR_EMAIL_HOST,
        port: 587,
        secure: false,
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
          <p> Payload:- </p> <pre>${data?.payload ?? "No Payload"}</pre>
          <p> Response:- </p> <pre>${data.response ?? "No Response"}</pre>
        </body>
        </html>
        `,
      };
      transporter.sendMail(message, function (err, info) {
        resolve(true);
      });
    } catch (error) {
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

/**
 * check error already exists or not.
 * @param {*} singleItem
 * @returns
 */
async function checkSameError(singleItem) {
  try {
    const documentClient = new AWS.DynamoDB.DocumentClient({
      region: process.env.REGION,
    });

    const params = {
      TableName: process.env.NETSUIT_AP_ERROR_TABLE,
      FilterExpression:
        "#vendor_id = :vendor_id AND #errorDescription = :errorDescription",
      ExpressionAttributeNames: {
        "#vendor_id": "vendor_id",
        "#errorDescription": "errorDescription",
      },
      ExpressionAttributeValues: {
        ":vendor_id": singleItem.vendor_id,
        ":errorDescription": `Vendor not found. (vendor_id: ${singleItem.vendor_id})`,
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

async function startNetsuitInvoiceStep() {
  return new Promise((resolve, reject) => {
    try {
      const params = {
        stateMachineArn: process.env.NETSUITE_AP_WT_STEP_ARN,
        input: JSON.stringify({}),
      };
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.startExecution(params, (err, data) => {
        if (err) {
          console.log("Netsuit AP api trigger failed");
          resolve(false);
        } else {
          console.log("Netsuit AP started");
          resolve(true);
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}
