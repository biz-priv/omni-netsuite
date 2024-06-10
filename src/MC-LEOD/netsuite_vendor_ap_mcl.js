/*
* File: src\MC-LEOD\netsuite_vendor_ap_mcl.js
* Project: Omni-netsuite
* Author: Bizcloud Experts
* Date: 2023-07-15
* Confidential and Proprietary
*/
const AWS = require("aws-sdk");
const pgp = require("pg-promise");
var NsApiWrapper = require("netsuite-rest");
const dbc = pgp({ capSQL: true });
const {
  getConfig,
  getConnectionToRds,
  createAPFailedRecords,
  sendDevNotification,
} = require("../../Helpers/helper");
const moment = require("moment");

let userConfig = "";

let totalCountPerLoop = 5;
const today = getCustomDate();
const apDbNamePrev = process.env.DATABASE_NAME;
const apDbName = apDbNamePrev + "interface_ap";
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
     * Get data from db
     */
    const vendorList = await getVendorData(connections);
    console.info("vendorList", vendorList.length);
    currentCount = vendorList.length;

    for (let i = 0; i < vendorList.length; i++) {
      const vendor_id = vendorList[i].vendor_id;
      console.info("vendor_id", vendor_id);
      try {
        /**
         * get vendor from netsuit
         */
        const vendorData = await getVendor(vendor_id);

        /**
         * Update vendor details into DB
         */
        await putVendor(connections, vendorData, vendor_id);
        console.info("count", i + 1);
      } catch (error) {
        let singleItem = "";
        try {
          if (error.hasOwnProperty("customError")) {
            /**
             * update error
             */
            singleItem = await getDataByVendorId(connections, vendor_id);
            await updateFailedRecords(connections, vendor_id);
            await createAPFailedRecords(
              connections,
              singleItem,
              error,
              "mysql",
              apDbNamePrev
            );
          }
        } catch (error) {
          await sendDevNotification(
            source_system,
            "AP",
            "netsuite_vendor_ap_mcl for loop vendor id =" + vendor_id,
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

async function getVendorData(connections) {
  try {
    const query = `SELECT distinct vendor_id FROM ${apDbName}
                    where ((vendor_internal_id is null and processed_date is null) or
                            (vendor_internal_id is null and processed_date < '${today}'))
                    and source_system = '${source_system}'
                    limit ${totalCountPerLoop + 1}`;
    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found";
    }
    return result;
  } catch (error) {
    console.error(error, "error");
    throw "getVendorData: No data found.";
  }
}

async function getDataByVendorId(connections, vendor_id) {
  try {
    const query = `select * from ${apDbName} 
                    where source_system = '${source_system}' and vendor_id = '${vendor_id}' 
                    limit 1`;
    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result[0];
  } catch (error) {
    throw "getDataByVendorId: No data found.";
  }
}

function getVendor(entityId) {
  return new Promise((resolve, reject) => {
    const NsApi = new NsApiWrapper({
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
    });
    NsApi.request({
      path: `record/v1/vendor/eid:${entityId}`,
    })
      .then((response) => {
        const recordList = response.data;
        if (recordList && recordList.id) {
          const record = recordList;
          resolve(record);
        } else {
          reject({
            customError: true,
            msg: `Vendor not found. (vendor_id: ${entityId})`,
          });
        }
      })
      .catch((err) => {
        console.error("err", err);
        reject({
          customError: true,
          msg: `Vendor not found. (vendor_id: ${entityId})`,
        });
      });
  });
}

async function putVendor(connections, vendorData, vendor_id) {
  try {
    const vendor_internal_id = vendorData.id;

    const formatData = {
      vendor_internal_id: vendorData?.id ?? "",
      vendor_id: vendorData?.entityId ?? "",
      externalId: vendorData?.externalId,
      balance: vendorData?.balance,
      balancePrimary: vendorData?.balancePrimary,
      companyName: vendorData?.companyName,
      currency_internal_id: vendorData?.currency.id,
      curr_cd: vendorData?.currency.refName,
      currency_id: vendorData?.currency.id,
      currency_refName: vendorData?.currency.refName,
      custentity_1099_misc: vendorData?.custentity_1099_misc,
      custentity_11724_pay_bank_fees:
        vendorData?.custentity_11724_pay_bank_fees,
      custentity_2663_payment_method:
        vendorData?.custentity_2663_payment_method,
      custentity_riv_external_id: vendorData?.custentity_riv_external_id,
      dateCreated: vendorData?.dateCreated,
      defaultAddress: vendorData?.defaultAddress,
      emailTransactions: vendorData?.emailTransactions,
      faxTransactions: vendorData?.faxTransactions,
      isAutogeneratedRepresentingEntity:
        vendorData?.isAutogeneratedRepresentingEntity,
      isInactive: vendorData?.isInactive,
      isJobResourceVend: vendorData?.isJobResourceVend,
      isPerson: vendorData?.isPerson,
      lastModifiedDate: vendorData?.lastModifiedDate,
      legalName: vendorData?.legalName,
      phone: vendorData?.phone,
      printTransactions: vendorData?.printTransactions,
      subsidiaryEdition: vendorData?.subsidiaryEdition,
      unbilledOrders: vendorData?.unbilledOrders,
      unbilledOrdersPrimary: vendorData?.unbilledOrdersPrimary,

      customForm_id: vendorData?.customForm.id,
      customForm_refName: vendorData?.customForm.refName,
      emailPreference_id: vendorData?.emailPreference.id,
      emailPreference_refName: vendorData?.emailPreference.refName,
      subsidiary_id: vendorData?.subsidiary.id,
      subsidiary_refName: vendorData?.subsidiary.refName,

      created_at: moment().format("YYYY-MM-DD"),
    };


    let tableStr = "";
    let valueStr = "";
    let updateStr = "";

    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
        updateStr += e != "vendor_id" ? "," : "";
      }
      if (e != "vendor_id") {
        updateStr += e + "='" + formatData[e] + "'";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");


    const upsertQuery = `INSERT INTO ${apDbNamePrev}netsuit_vendors (${tableStr})
                        VALUES (${valueStr}) ON DUPLICATE KEY
                        UPDATE ${updateStr};`;
    console.info("query", upsertQuery);
    await connections.execute(upsertQuery);

    const updateQuery = `UPDATE  ${apDbName} SET
                    processed = null,
                    vendor_internal_id = '${vendor_internal_id}', 
                    processed_date = '${today}' 
                    WHERE vendor_id = '${vendor_id}' and source_system = '${source_system}' and vendor_internal_id is null;`;
    console.info("updateQuery", updateQuery);
    await connections.execute(updateQuery);
  } catch (error) {
    console.error(error);
    throw "Vendor Update Failed";
  }
}

async function updateFailedRecords(connections, vendor_id) {
  try {
    let query = `UPDATE ${apDbName} SET 
                  processed = 'F',
                  processed_date = '${today}' 
                  WHERE vendor_id = '${vendor_id}' and source_system = '${source_system}' and vendor_internal_id is null`;
    const result = await connections.query(query);
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

async function checkOldProcessIsRunning() {
  return new Promise((resolve, reject) => {
    try {
      //WT AP vendor
      const vendorArn = process.env.NETSUITE_AP_MCL_VENDOR_STEP_ARN;
      //WT AP
      const wtApArn = process.env.NETSUITE_MCL_AP_STEP_ARN;

      const status = "RUNNING";
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.listExecutions(
        {
          stateMachineArn: vendorArn,
          statusFilter: status,
          maxResults: 2,
        },
        (err, data) => {
          console.info(" vendorArn listExecutions data", data);
          const venExcList = data.executions;
          if (
            err === null &&
            venExcList.length == 2 &&
            venExcList[1].status === status
          ) {
            console.info("vendorArn running");
            resolve(true);
          } else {
            stepfunctions.listExecutions(
              {
                stateMachineArn: wtApArn,
                statusFilter: status,
                maxResults: 1,
              },
              (err, data) => {
                console.info(" wtApArn listExecutions data", data);
                const wtapExcList = data.executions;
                if (
                  err === null &&
                  wtapExcList.length > 0 &&
                  wtapExcList[0].status === status
                ) {
                  console.info("wtApArn running");
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

async function startNetsuitInvoiceStep() {
  return new Promise((resolve, reject) => {
    try {
      const params = {
        stateMachineArn: process.env.NETSUITE_MCL_AP_STEP_ARN,
        input: JSON.stringify({}),
      };
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.startExecution(params, (err, data) => {
        if (err) {
          console.info("Netsuit AP api trigger failed");
          resolve(false);
        } else {
          console.info("Netsuit AP started");
          resolve(true);
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}
