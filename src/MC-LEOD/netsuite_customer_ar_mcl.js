const AWS = require("aws-sdk");
var NsApiWrapper = require("netsuite-rest");
const {
  getConfig,
  getConnectionToRds,
  createARFailedRecords,
  sendDevNotification,
} = require("../../Helpers/helper");

let userConfig = "";

let totalCountPerLoop = 5;
const today = getCustomDate();

const arDbNamePrev = "dw_uat.";
const arDbName = arDbNamePrev + "interface_ar";
const source_system = "OL";

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
    const connections = await getConnectionToRds(process.env);

    /**
     * Get data from  db
     */
    const customerList = await getCustomerData(connections);

    console.log("customerList", customerList);
    currentCount = customerList.length;
    console.log("currentCount", currentCount);

    for (let i = 0; i < customerList.length; i++) {
      const customer_id = customerList[i].customer_id;
      console.log("customer_id", customer_id);
      try {
        /**
         * get customer from netsuit
         */
        const customerData = await getcustomer(customer_id);
        console.log("customerData", customerData);
        /**
         * Update customer details into DB
         */
        await putCustomer(connections, customerData, customer_id);
        console.log("count", i + 1);
      } catch (error) {
        let singleItem = "";
        try {
          if (error.hasOwnProperty("customError")) {
            /**
             * update error
             */
            singleItem = await getDataByCustomerId(connections, customer_id);
            // console.log("singleItem", singleItem);
            await updateFailedRecords(connections, customer_id);
            await createARFailedRecords(
              connections,
              singleItem,
              error,
              "mysql",
              arDbNamePrev
            );
          }
        } catch (error) {
          console.log("err", error);
          await sendDevNotification(
            source_system,
            "AR",
            "netsuite_customer_ar_wt for loop customer_id" + customer_id,
            singleItem,
            error
          );
        }
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
    return { hasMoreData };
  } else {
    return { hasMoreData };
  }
};

async function getCustomerData(connections) {
  try {
    const query = `SELECT distinct customer_id FROM ${arDbName} 
                    where ((customer_internal_id is null and processed_date is null) or
                          (customer_internal_id is null and processed_date < '${today}'))
                          and source_system = '${source_system}'
                          limit ${totalCountPerLoop + 1}`;

    console.log("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    console.log("result", result);
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
    const query = `SELECT * FROM ${arDbName} 
                    where source_system = '${source_system}' and customer_id = '${cus_id}' 
                    limit 1`;
    console.log("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    console.log("result", result);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result[0];
  } catch (error) {
    throw "getDataByCustomerId: No data found.";
  }
}

function getcustomer(entityId) {
  return new Promise((resolve, reject) => {
    const NsApi = new NsApiWrapper({
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
    });
    NsApi.request({
      path: `record/v1/customer/eid:${entityId}`,
    })
      .then((response) => {
        const recordList = response.data;
        if (recordList && recordList.id) {
          const record = recordList;
          resolve({
            entityId: record.entityId,
            entityInternalId: record.id,
          });
        } else {
          reject({
            customError: true,
            msg: `Customer not found. (customer_id: ${entityId})`,
          });
        }
      })
      .catch((err) => {
        console.log("error", err);
        reject({
          customError: true,
          msg: `Customer not found. (customer_id: ${entityId})`,
        });
      });
  });
}

async function putCustomer(connections, customerData, customer_id) {
  try {
    const upsertQuery = `INSERT INTO dw_uat.netsuit_customer (customer_id, customer_internal_id, curr_cd, currency_internal_id )
                  VALUES ('${customerData.entityId}', '${customerData.entityInternalId}','','') ON DUPLICATE KEY
                  UPDATE customer_internal_id='${customerData.entityInternalId}', curr_cd='',currency_internal_id='';`;
    console.log("query", upsertQuery);
    await connections.execute(upsertQuery);

    const updateQuery = `UPDATE ${arDbName} SET 
                    processed = null, 
                    customer_internal_id = '${customerData.entityInternalId}', 
                    processed_date = '${today}' 
                    WHERE customer_id = '${customer_id}' and source_system = '${source_system}' and customer_internal_id is null`;
    console.log("updateQuery", updateQuery);
    await connections.execute(updateQuery);
  } catch (error) {
    throw "Customer Update Failed";
  }
}

async function updateFailedRecords(connections, cus_id) {
  try {
    let query = `UPDATE ${arDbName}  
                  SET processed = 'F',
                  processed_date = '${today}' 
                  WHERE customer_id = '${cus_id}' and source_system = '${source_system}' and customer_internal_id is null`;
    console.log("query", query);
    const result = await connections.execute(query);
    console.log("result", result);
    return result;
  } catch (error) {}
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
        stateMachineArn: process.env.NETSUITE_MCL_AR_STEP_ARN,
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
      //MCL ar customer
      const customerArn = process.env.NETSUITE_AR_MCL_CUSTOMER_STEP_ARN;
      //MCL ar
      const mclArArn = process.env.NETSUITE_MCL_AR_STEP_ARN;

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
                stateMachineArn: mclArArn,
                statusFilter: status,
                maxResults: 1,
              },
              (err, data) => {
                console.log(" mclArArn listExecutions data", data);
                const wtapExcList = data.executions;
                if (
                  err === null &&
                  wtapExcList.length > 0 &&
                  wtapExcList[0].status === status
                ) {
                  console.log("mclArArn running");
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
