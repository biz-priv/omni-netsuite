const AWS = require("aws-sdk");
const nodemailer = require("nodemailer");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const NetSuite = require("node-suitetalk");
const {
  getConfig,
  getConnection,
  createAPFailedRecords,
  sendDevNotification,
} = require("../../Helpers/helper");
const Configuration = NetSuite.Configuration;
const Service = NetSuite.Service;
const Search = NetSuite.Search;

let userConfig = "";

let totalCountPerLoop = 5;
let nextOffset = 0;
const today = getCustomDate();
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
        let singleItem = "";
        try {
          if (error.hasOwnProperty("customError")) {
            /**
             * update error
             */
            singleItem = await getDataByVendorId(connections, vendor_id);
            await updateFailedRecords(connections, vendor_id);
            /**
             * check if same error from dynamo db
             * true if already notification sent
             * false if it is new
             */
            await createAPFailedRecords(connections, singleItem, error);
          }
        } catch (error) {
          await sendDevNotification(
            source_system,
            "AP",
            "netsuite_vendor_ap_tr for loop vendor id =" + vendor_id,
            singleItem,
            error
          );
        }
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

async function getVendorData(connections) {
  try {
    const query = `SELECT distinct vendor_id FROM interface_ap_master 
                    where ((vendor_internal_id = '' and processed_date is null) or
                            (vendor_internal_id = '' and processed_date < '${today}'))
                          and source_system = '${source_system}' order by vendor_id 
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
    const query = `SELECT ia.*, iam.vendor_internal_id ,iam.currency_internal_id  FROM interface_ap ia 
                  left join interface_ap_master iam on 
                  ia.invoice_nbr = iam.invoice_nbr and
                  ia.invoice_type = iam.invoice_type and 
                  ia.vendor_id = iam.vendor_id and 
                  ia.gc_code = iam.gc_code and 
                  ia.source_system = iam.source_system and 
                  iam.file_nbr = ia.file_nbr 
                  where ia.source_system = '${source_system}' and
                  ia.vendor_id = '${vendor_id}' limit 1`;

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
        stateMachineArn: process.env.NETSUITE_AP_TR_STEP_ARN,
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

async function checkOldProcessIsRunning() {
  return new Promise((resolve, reject) => {
    try {
      //TR AP vendor
      const vendorArn = process.env.NETSUITE_AP_TR_VENDOR_STEP_ARN;
      //TR AP
      const trApArn = process.env.NETSUITE_AP_TR_STEP_ARN;

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
