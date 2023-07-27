const AWS = require("aws-sdk");
var NsApiWrapper = require("netsuite-rest");
const {
  getConfig,
  getConnectionToRds,
  createARFailedRecords,
  sendDevNotification,
} = require("../../Helpers/helper");
const moment = require("moment");

let userConfig = "";

let totalCountPerLoop = 5;
const today = getCustomDate();

const arDbNamePrev = process.env.DATABASE_NAME;
const arDbName = arDbNamePrev + "interface_ar";
const source_system = "CW";

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
        console.info("customerData", customerData);
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
          console.log("err", error);
          await sendDevNotification(
            source_system,
            "AR",
            "netsuite_customer_ar_cw for loop customer_id" + customer_id,
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
                    where customer_internal_id is null and ( processed_date is null or
                           processed_date < '${today}')
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
    console.log("query", query);
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
          resolve(record);
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

// async function getcustomer(entityId) {
//   try {
//     const options = {
//       consumer_key: userConfig.token.consumer_key,
//       consumer_secret_key: userConfig.token.consumer_secret,
//       token: userConfig.token.token_key,
//       token_secret: userConfig.token.token_secret,
//       realm: userConfig.account,
//       url: `${process.env.NETSUIT_BASE_URL}/app/site/hosting/restlet.nl?script=1124&deploy=1&custscript_mfc_entity_eid=${entityId}`,
//       method: "GET",
//     };
//     const authHeader = await getAuthorizationHeader(options);

//     const configApi = {
//       method: options.method,
//       maxBodyLength: Infinity,
//       url: options.url,
//       headers: {
//         ...authHeader,
//       },
//     };
    
//     const response =  await axios.request(configApi);

//     console.info("response", response.status);
//     const recordList = response.data[0];
//     if (recordList && recordList.internalid) {
//       const record = recordList;
//       return record;
//     } else {
//       throw {
//         customError: true,
//         msg: `Customer not found. (customer_id: ${entityId})`,
//       };
//     }
//   } catch (err) {
//     console.error("error", err);
//     throw {
//       customError: true,
//       msg: `Customer not found. (customer_id: ${entityId})`,
//     };
//   }
// }

async function putCustomer(connections, customerData, customer_id) {
  try {
    const customer_internal_id = customerData.id;

    const formatData = {
      customer_internal_id: customerData?.id ?? "",
      customer_id: customerData?.entityId ?? "",
      currency_internal_id: customerData?.currency.id,
      curr_cd: customerData?.currency.refName,
      currency_id: customerData?.currency.id,
      currency_refName: customerData?.currency.refName,
      externalId: customerData?.externalId ?? "",
      custentity5: customerData?.custentity5 ?? "",
      custentity_2663_customer_refund:
        customerData?.custentity_2663_customer_refund ?? "",
      custentity_2663_direct_debit:
        customerData?.custentity_2663_direct_debit ?? "",
      custentity_ee_account_no: customerData?.custentity_ee_account_no ?? "",
      custentity_riv_assigned_collector:
        customerData?.custentity_riv_assigned_collector ?? "",
      dateCreated: customerData?.dateCreated ?? "",
      daysOverdue: customerData?.daysOverdue ?? "",
      defaultAddress:
        customerData?.defaultAddress.length > 0
          ? customerData?.defaultAddress.replace(/'/g, "`")
          : "",
      depositBalance: customerData?.depositBalance ?? "",
      autoName: customerData?.autoName ?? "",
      balance: customerData?.balance ?? "",
      companyName:
        customerData?.companyName.length > 0
          ? customerData?.companyName.replace(/'/g, "`")
          : "",
      emailTransactions: customerData?.emailTransactions ?? "",
      faxTransactions: customerData?.faxTransactions ?? "",
      isAutogeneratedRepresentingEntity:
        customerData?.isAutogeneratedRepresentingEntity ?? "",
      isInactive: customerData?.isInactive ?? "",
      isPerson: customerData?.isPerson ?? "",
      lastModifiedDate: customerData?.lastModifiedDate ?? "",
      overdueBalance: customerData?.overdueBalance ?? "",
      printTransactions: customerData?.printTransactions ?? "",
      unbilledOrders: customerData?.unbilledOrders ?? "",
      shipComplete: customerData?.shipComplete ?? "",

      alcoholRecipientType_id: customerData?.alcoholRecipientType.id,
      alcoholRecipientType_refName: customerData?.alcoholRecipientType.refName,
      creditHoldOverride_id: customerData?.creditHoldOverride.id,
      creditHoldOverride_refName: customerData?.creditHoldOverride.refName,
      customForm_id: customerData?.customForm.id,
      customForm_refName: customerData?.customForm.refName,
      emailPreference_id: customerData?.emailPreference.id,
      emailPreference_refName: customerData?.emailPreference.refName,
      entityStatus_id: customerData?.entityStatus.id,
      entityStatus_refName: customerData?.entityStatus.refName,
      receivablesAccount_id: customerData?.receivablesAccount.id,
      receivablesAccount_refName: customerData?.receivablesAccount.refName,
      shippingCarrier_id: customerData?.shippingCarrier.id,
      shippingCarrier_refName: customerData?.shippingCarrier.refName,
      subsidiary_id: customerData?.subsidiary.id,
      subsidiary_refName: customerData?.subsidiary.refName,
      terms_id: customerData?.terms.id,
      terms_refName: customerData?.terms.refName,
      created_at: moment().format("YYYY-MM-DD"),
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
    console.log("query", upsertQuery);
    await connections.execute(upsertQuery);

    const updateQuery = `UPDATE ${arDbName} SET 
                    processed = null, 
                    customer_internal_id = '${customer_internal_id}', 
                    processed_date = '${today}' 
                    WHERE customer_id = '${customer_id}' and source_system = '${source_system}' and customer_internal_id is null`;
    console.log("updateQuery", updateQuery);
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
    console.log("query", query);
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
        stateMachineArn: process.env.NETSUITE_AR_CW_STEP_ARN,
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
      //cw ar customer
      const customerArn = process.env.NETSUITE_AR_CW_CUSTOMER_STEP_ARN;
      //cw ar
      const mclArArn = process.env.NETSUITE_AR_CW_STEP_ARN;

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
                const cwapExcList = data.executions;
                if (
                  err === null &&
                  cwapExcList.length > 0 &&
                  cwapExcList[0].status === status
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
