const AWS = require("aws-sdk");
const {SNS_TOPIC_ARN } = process.env;
const sns = new AWS.SNS({ region: process.env.REGION });
const axios = require("axios");
const {
  getConfig,
  getConnectionToRds,
  createARFailedRecords,
  getAuthorizationHeader,
  sendDevNotification,
} = require("../../Helpers/helper");
const moment = require("moment");

let userConfig = "";

let totalCountPerLoop = 5;
const today = getCustomDate();

const arDbNamePrev = process.env.DATABASE_NAME;
const arDbName = arDbNamePrev + "interface_ar";
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
    const connections = await getConnectionToRds(process.env);

    /**
     * Get data from  db
     */
    const customerList = await getCustomerData(connections);
    console.info("customerList", customerList);

    currentCount = customerList.length;

    for (let i = 0; i < customerList.length; i++) {
      const customer_id = customerList[i].customer_id;
      console.info("customer_id", customer_id);
      try {
        /**
         * get customer from netsuit
         */
        const customerData = await getcustomer(customer_id);
        console.info("customerData",customerData);
        /**
         * Update customer details into DB
         */
        await putCustomer(connections, customerData, customer_id);
        console.info("count", i + 1);
      } catch (error) {
        let singleItem = "";
        try {
          if (error.hasOwnProperty("customError")) {
            /**
             * update error
             */
            singleItem = await getDataByCustomerId(connections, customer_id);
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
          console.error("err", error);
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
    const params = {
			Message: `Error in ${functionName}, Error: ${error.Message}`,
			TopicArn: SNS_TOPIC_ARN,
		};
    await sns.publish(params).promise();
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

    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
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
    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result[0];
  } catch (error) {
    throw "getDataByCustomerId: No data found.";
  }
}

async function getcustomer(entityId) {
  try {
    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: `${process.env.NETSUIT_BASE_URL}/app/site/hosting/restlet.nl?script=1124&deploy=1&custscript_mfc_entity_eid=${entityId}`,
      method: "GET",
    };
    const authHeader = await getAuthorizationHeader(options);

    const configApi = {
      method: options.method,
      maxBodyLength: Infinity,
      url: options.url,
      headers: {
        ...authHeader,
      },
    };
    
    const response =  await axios.request(configApi);

    console.info("response", response.status);
    const recordList = response.data[0];
    if (recordList && recordList.internalid) {
      const record = recordList;
      return record;
    } else {
      throw {
        customError: true,
        msg: `Customer not found. (customer_id: ${entityId})`,
      };
    }
  } catch (err) {
    console.error("error", err);
    throw {
      customError: true,
      msg: `Customer not found. (customer_id: ${entityId})`,
    };
  }
}

async function putCustomer(connections, customerData, customer_id) {
  try {
    const customer_internal_id = customerData.internalid;

    const formatData = {
      customer_internal_id: customerData?.internalid ?? "",
      customer_id: customerData?.entityid ?? "",
    };

    let tableStr = "";
    let valueStr = "";
    let updateStr = "";

    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
        updateStr += e != "customer_id" ? "," : "";
      }
      if (e != "customer_id") {
        updateStr += e + "='" + formatData[e] + "'";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");


    const upsertQuery = `INSERT INTO ${arDbNamePrev}netsuit_customer (${tableStr})
                        VALUES (${valueStr}) ON DUPLICATE KEY
                        UPDATE ${updateStr};`;
    console.info("query", upsertQuery);
    await connections.execute(upsertQuery);

    const updateQuery = `UPDATE ${arDbName} SET 
                    processed = null, 
                    customer_internal_id = '${customer_internal_id}', 
                    processed_date = '${today}' 
                    WHERE customer_id = '${customer_id}' and source_system = '${source_system}' and customer_internal_id is null`;
    console.info("updateQuery", updateQuery);
    await connections.execute(updateQuery);
  } catch (error) {
    console.error(error);
    throw "Customer Update Failed";
  }
}

async function updateFailedRecords(connections, cus_id) {
  try {
    let query = `UPDATE ${arDbName}  
                  SET processed = 'F',
                  processed_date = '${today}' 
                  WHERE customer_id = '${cus_id}' and source_system = '${source_system}' and customer_internal_id is null`;
    console.info("query", query);
    const result = await connections.execute(query);
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
        stateMachineArn: process.env.NETSUITE_AR_WT_STEP_ARN,
        input: JSON.stringify({}),
      };
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.startExecution(params, (err, data) => {
        if (err) {
          console.error("Netsuit Ar api trigger failed");
          resolve(false);
        } else {
          console.info("Netsuit Ar started");
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
      //WT ar customer
      const customerArn = process.env.NETSUITE_AR_WT_CUSTOMER_STEP_ARN;
      //WT ar
      const mclArArn = process.env.NETSUITE_AR_WT_STEP_ARN;

      const status = "RUNNING";
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.listExecutions(
        {
          stateMachineArn: customerArn,
          statusFilter: status,
          maxResults: 2,
        },
        (err, data) => {
          console.info(" customerArn listExecutions data", data);
          const venExcList = data.executions;
          if (
            err === null &&
            venExcList.length == 2 &&
            venExcList[1].status === status
          ) {
            console.info("customerArn running");
            resolve(true);
          } else {
            stepfunctions.listExecutions(
              {
                stateMachineArn: mclArArn,
                statusFilter: status,
                maxResults: 1,
              },
              (err, data) => {
                console.info(" mclArArn listExecutions data", data);
                const wtapExcList = data.executions;
                if (
                  err === null &&
                  wtapExcList.length > 0 &&
                  wtapExcList[0].status === status
                ) {
                  console.info("mclArArn running");
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
