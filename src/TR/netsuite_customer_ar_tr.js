const AWS = require("aws-sdk");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const nodemailer = require("nodemailer");
const NetSuite = require("node-suitetalk");
const {
  getConfig,
  getConnection,
  createARFailedRecords,
} = require("../../Helpers/helper");
const Configuration = NetSuite.Configuration;
const Service = NetSuite.Service;
const Search = NetSuite.Search;

let userConfig = "";

let totalCountPerLoop = 10;
let nextOffset = 0;
const today = getCustomDate();

const arDbName = "interface_ar";
const source_system = "TR";
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

  nextOffset = event.hasOwnProperty("nextOffsetCount")
    ? event.nextOffsetCount
    : 0;
  const nextOffsetCount = nextOffset + totalCountPerLoop + 1;
  try {
    /**
     * Get connections
     */
    const connections = dbc(getConnection(process.env));

    /**
     * Get data from db
     */
    const customerList = await getCustomerData(connections);

    console.log("customerList", customerList.length, customerList);
    currentCount = customerList.length;
    // return {};

    for (let i = 0; i < customerList.length; i++) {
      const customer_id = customerList[i].customer_id;
      try {
        /**
         * get customer from netsuit
         */
        const customerData = await getcustomer(customer_id);
        /**
         * Update customer details into DB
         */
        await putCustomer(connections, customerData, customer_id);
        console.log("count", i + 1);
      } catch (error) {
        try {
          if (error.hasOwnProperty("customError")) {
            /**
             * update error
             */
            const singleItem = await getDataByCustomerId(
              connections,
              customer_id
            );
            await updateFailedRecords(connections, customer_id);
            /**
             * check if same error from dynamo db
             * true if already notification sent
             * false if it is new
             */
            await recordErrorResponse(singleItem, error);
            // await createARFailedRecords(connections, singleItem, error);
          }
        } catch (error) {}
      }
    }
    dbc.end();
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
    return { hasMoreData };
  } else {
    return { hasMoreData, nextOffsetCount };
  }
};

async function getCustomerData(connections) {
  try {
    const query = `SELECT distinct customer_id FROM ${arDbName} 
                          where ((customer_internal_id = '' and processed_date is null) or
                                  (customer_internal_id = '' and processed_date < '${today}'))
                                and source_system = '${source_system}' order by customer_id 
                                limit ${totalCountPerLoop + 1}`;
    console.log("query", query);
    const result = await connections.query(query);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    throw "getCustomerData: No data found.";
  }
}

async function getDataByCustomerId(connections, cus_id) {
  try {
    const query = `SELECT * FROM ${arDbName} where source_system = '${source_system}' 
                    and customer_id = '${cus_id}' limit 1`;
    const result = await connections.query(query);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result[0];
  } catch (error) {
    throw "getDataByCustomerId: No data found.";
  }
}

async function putCustomer(connections, customerData, customer_id) {
  try {
    let query = `INSERT INTO netsuit_customer (customer_id, customer_internal_id, curr_cd, currency_internal_id )
                  VALUES ('${customerData.entityId}', '${customerData.entityInternalId}','','');`;
    query += `UPDATE ${arDbName} SET 
                    processed = '', 
                    customer_internal_id = '${customerData.entityInternalId}', 
                    processed_date = '${today}' 
                    WHERE customer_id = '${customer_id}' and source_system = '${source_system}' and customer_internal_id = '';`;
    await connections.query(query);
  } catch (error) {
    throw "Customer Update Failed";
  }
}

function getcustomer(entityId) {
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
              msg: `Customer not found. (customer_id: ${entityId})`,
            });
          }
        } else {
          reject({
            customError: true,
            msg: `Customer not found. (customer_id: ${entityId})`,
          });
        }
      })
      .catch((err) => {
        reject({
          customError: true,
          msg: `Customer Api failed. (customer_id: ${entityId})`,
        });
      });
  });
}

async function updateFailedRecords(connections, cus_id) {
  try {
    let query = `UPDATE ${arDbName}  
                  SET processed = 'F',
                  processed_date = '${today}' 
                  WHERE customer_id = '${cus_id}' and source_system = '${source_system}' and customer_internal_id = ''`;
    const result = await connections.query(query);
    return result;
  } catch (error) {}
}

async function recordErrorResponse(item, error) {
  try {
    // let documentClient = new AWS.DynamoDB.DocumentClient({
    //   region: process.env.REGION,
    // });
    const data = {
      id: item.invoice_nbr + item.invoice_type,
      invoice_nbr: item.invoice_nbr,
      customer_id: item.customer_id,
      subsidiary: item.subsidiary,
      source_system: item.source_system,
      invoice_type: item.invoice_type,
      invoice_date: item.invoice_date.toLocaleString(),
      charge_cd_internal_id: item.charge_cd_internal_id,
      errorDescription: error?.msg + "Subsidiary: " + item.subsidiary,
      payload: error?.payload,
      response: error?.response,
      invoiceId: error?.invoiceId,
      status: "error",
      created_at: new Date().toLocaleString(),
    };
    // const params = {
    //   TableName: process.env.NETSUIT_AR_ERROR_TABLE,
    //   Item: data,
    // };
    // await documentClient.put(params).promise();
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
        secure: false, // true for 465, false for other ports
        auth: {
          user: process.env.NETSUIT_AR_ERROR_EMAIL_USER,
          pass: process.env.NETSUIT_AR_ERROR_EMAIL_PASS,
        },
      });

      const message = {
        from: `Netsuite <${process.env.NETSUIT_AR_ERROR_EMAIL_FROM}>`,
        to: process.env.NETSUIT_AR_ERROR_EMAIL_TO,
        // to: "kazi.ali@bizcloudexperts.com,kiranv@bizcloudexperts.com,priyanka@bizcloudexperts.com,wwaller@omnilogistics.com",
        subject: `${source_system} - Netsuite AR ${process.env.STAGE.toUpperCase()} Invoices - Error`,
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

async function startNetsuitInvoiceStep() {
  return new Promise((resolve, reject) => {
    try {
      const params = {
        stateMachineArn: process.env.NETSUITE_AR_TR_STEP_ARN,
        input: JSON.stringify({}),
      };
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.startExecution(params, (err, data) => {
        if (err) {
          console.log("Netsuit Ar api trigger failed");
          resolve(false);
        } else {
          console.log("Netsuit Ar started");
          resolve(true);
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}

async function checkOldProcessIsRunning() {
  return new Promise((resolve, reject) => {
    try {
      //TR AP customer
      const customerArn = process.env.NETSUITE_AR_TR_CUSTOMER_STEP_ARN;
      //TR AP
      const trApArn = process.env.NETSUITE_AR_TR_STEP_ARN;

      const status = "RUNNING";
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.listExecutions(
        {
          stateMachineArn: customerArn,
          statusFilter: status,
          maxResults: 2,
        },
        (err, data) => {
          console.log(" customerArn listExecutions data", data);
          const venExcList = data.executions;
          if (
            err === null &&
            venExcList.length == 2 &&
            venExcList[1].status === status
          ) {
            console.log("customerArn running");
            resolve(true);
          } else {
            stepfunctions.listExecutions(
              {
                stateMachineArn: trApArn,
                statusFilter: status,
                maxResults: 1,
              },
              (err, data) => {
                console.log(" trApArn listExecutions data", data);
                const wtapExcList = data.executions;
                if (
                  err === null &&
                  wtapExcList.length > 0 &&
                  wtapExcList[0].status === status
                ) {
                  console.log("trApArn running");
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
