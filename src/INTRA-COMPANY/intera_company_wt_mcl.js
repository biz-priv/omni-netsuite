const AWS = require("aws-sdk");
const axios = require("axios");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const {
  getConfig,
  createIntracompanyFailedRecords,
  triggerReportLambda,
  sendDevNotification,
  getConnectionToRds,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");

const payload_source_system = ["CW", "WT"]

let userConfig = "";
let connections = "";

const today = getCustomDate();
const totalCountPerLoop = 15;

// mcl-ar => wt-ap
const source_system = "OL";
const arDbName = "interface_ar_intracompany";
const apDbName = "interface_ap_intracompany";

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
  try {
    /**
     * Get connections
     */
    connections = await getConnectionToRds(process.env);

    /**
     * Get invoice internal ids from
     */
    const invoiceData = await getUniqueRecords();

    console.log("invoiceData", invoiceData, invoiceData.length);
    currentCount = invoiceData.length;

    for (let i = 0; i < invoiceData.length; i++) {
      const item = invoiceData[i];
      const itemUniqueKey = item.invoice_nbr;
      console.log("item", item, itemUniqueKey);

      const records = await getRecordDetails(item);

      await mainProcess(item.source_system,records, itemUniqueKey);
      console.log("count", i + 1);
    }

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
      await Promise.all(payload_source_system.map(async (e) => {
        await triggerReportLambda(
          process.env.NETSUIT_INVOICE_REPORT,
          `${e}_INTRACOMPANY`
        );
      }))

      hasMoreData = "false";
    }
    // dbc.end();
    return { hasMoreData };
  } catch (error) {
    console.log("error:handler", error);
    // dbc.end();
    await Promise.all(payload_source_system.map(async (e) => {
      await triggerReportLambda(
        process.env.NETSUIT_INVOICE_REPORT,
        `${e}_INTRACOMPANY`
      );
    }))
    return { hasMoreData: "false" };
  }
};

/**
 * get data
 * @param {*} connections
 */
async function getUniqueRecords() {
  try {
    const query = `select distinct ar.invoice_nbr,ar.housebill_nbr,ap.source_system
        from dw_uat.interface_ap_intracompany ap
        join dw_uat.interface_ar_intracompany ar
        on ap.internal_ref_nbr =ar.housebill_nbr and ap.invoice_nbr =ar.invoice_nbr and ap.pairing_available_flag ='Y' 
        and ar.pairing_available_flag ='Y'
        where (
                (ap.internal_id is null and ap.processed is null and
                  ar.internal_id is null and ar.processed is null)
                or
                (ap.processed ='F' and ap.processed_date <= '${today}' and
                  ar.processed ='F' and ar.processed_date <= '${today}')
              )
        limit ${totalCountPerLoop + 1}`;


    console.log("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    // console.log("result", result);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.log("error:getData", error);
    throw "No data found.";
  }
}

async function getRecordDetails(item) {
  try {
    // console.log("item",item)
    const query = `select * from (select source_system,invoice_nbr,file_nbr ,id,subsidiary,currency ,master_bill_nbr,
      housebill_nbr,internal_ref_nbr as consol_housebill_nbr,business_segment,handling_stn,charge_cd ,charge_cd_internal_id,sales_person,invoice_date ,email ,finalizedby,
      rate as debit,null as credit,'40017' as account_num
      from dw_uat.interface_ap_intracompany where pairing_available_flag='Y'
      union
      select source_system,invoice_nbr,file_nbr ,id,subsidiary,currency ,master_bill_nbr,
      housebill_nbr,internal_ref_nbr as consol_housebill_nbr,business_segment,handling_stn,charge_cd ,charge_cd_internal_id,sales_person,invoice_date ,email ,finalizedby,
      null as debit,rate as credit,'71200' as account_num
      from dw_uat.interface_ap_intracompany where pairing_available_flag='Y'
      union
      select source_system,invoice_nbr,file_nbr ,id,subsidiary,currency ,master_bill_nbr ,
      housebill_nbr,housebill_nbr as consol_housebill_nbr,business_segment,handling_stn,charge_cd ,charge_cd_internal_id,sales_person,invoice_date ,email ,finalized_by,
      rate as debit,null as credit,'71200'  as account_num
      from dw_uat.interface_ar_intracompany where pairing_available_flag='Y'
      union
      select source_system,invoice_nbr,file_nbr ,id,subsidiary,currency ,master_bill_nbr ,
      housebill_nbr,housebill_nbr as consol_housebill_nbr,business_segment,handling_stn,charge_cd ,charge_cd_internal_id,sales_person,invoice_date ,email ,finalized_by,
      null as debit,rate as credit,'40017'  as account_num
      from dw_uat.interface_ar_intracompany where pairing_available_flag='Y') main
      where invoice_nbr='${item.invoice_nbr}' and consol_housebill_nbr='${item.housebill_nbr}'`;

    console.log("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    // console.log("result", result);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.log("error:getData", error);
    throw "No data found.";
  }
}

async function mainProcess(source_system,item, itemUniqueKey) {
  try {
    const payload = await makeJsonPayload(item);
    console.log("payload", payload);
    const internalId = await createInvoice(payload);
    console.log("internalId", internalId);

    await updateAPandAr(item, internalId);
  } catch (error) {
    console.log("error:mainProcess", error);
    if (error.hasOwnProperty("customError")) {
      await updateAPandAr(item, null, "F");
      await createIntracompanyFailedRecords(connections,source_system ,item, error);
    } else {
    }
  }
}

async function makeJsonPayload(data) {
  try {
    const bgs = getBusinessSegment(process.env.STAGE);
    const acc_internal_ids = {
      40017: 3023,
      71200: 3030,
    };

    /**
     * head level details
     */
    const singleItem = data.filter((e) => e.source_system === "WT" || "CW")[0];

    const payload = {
      custbody_mfc_omni_unique_key:
        singleItem.invoice_nbr + "-" + singleItem.housebill_nbr,
      trandate: singleItem.invoice_date,
      subsidiary: singleItem.subsidiary,
      currency: {
        refName: singleItem.currency,
      },
      memo: singleItem.housebill_nbr,
      line: data.map((e) => {
        return {
          custcol_mfc_line_unique_key: e.account_num + "-" + e.id, //check
          account: acc_internal_ids[e.account_num],
          debit: e.debit ?? 0,
          credit: e.credit ?? 0,
          memo: e.housebill_nbr ?? "",
          department: e.source_system === "WT" ? "2" : "1",
          class: bgs[e.business_segment.split(":")[1].trim().toLowerCase()],
          location: { refName: e.handling_stn },
          custcol3: e.sales_person ?? "",
          custcol5: e.master_bill_nbr ?? "",
          custcol_finalizedby: e.finalizedby ?? "",
          custbody17: e.email ?? "",
        };
      }),
    };
    console.log("payload", JSON.stringify(payload));
    return payload;
  } catch (error) {
    console.log("error payload", error);
    throw {
      customError: true,
      msg: "Unable to make payload",
      data: data[0],
    };
  }
}

function getAuthorizationHeader(options) {
  const oauth = OAuth({
    consumer: {
      key: options.consumer_key,
      secret: options.consumer_secret_key,
    },
    realm: options.realm,
    signature_method: "HMAC-SHA256",
    hash_function(base_string, key) {
      return crypto
        .createHmac("sha256", key)
        .update(base_string)
        .digest("base64");
    },
  });
  return oauth.toHeader(
    oauth.authorize(
      {
        url: options.url,
        method: options.method,
      },
      {
        key: options.token,
        secret: options.token_secret,
      }
    )
  );
}

function createInvoice(payload) {
  return new Promise((resolve, reject) => {
    try {
      const options = {
        consumer_key: userConfig.token.consumer_key,
        consumer_secret_key: userConfig.token.consumer_secret,
        token: userConfig.token.token_key,
        token_secret: userConfig.token.token_secret,
        realm: userConfig.account,
        url: `https://${userConfig.account
          .toLowerCase()
          .split("_")
          .join(
            "-"
          )}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_mfc_rl_mcleod_intra&deploy=customdeploy_mfc_rl_mcleod_intra`,
        method: "POST",
      };
      const authHeader = getAuthorizationHeader(options);

      const configApi = {
        method: options.method,
        maxBodyLength: Infinity,
        url: options.url,
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        data: JSON.stringify(payload),
      };

      axios
        .request(configApi)
        .then((response) => {
          console.log("response", response.status);
          console.log(JSON.stringify(response.data));
          if (response.status === 200 && response.data.status === "Success") {
            resolve(response.data.id);
          } else {
            reject({
              customError: true,
              msg: response.data.reason.replace(/'/g, "`"),
              payload: JSON.stringify(payload),
              response: JSON.stringify(response.data).replace(/'/g, "`"),
            });
          }
        })
        .catch((error) => {
          console.log(error.response.status);
          console.log(error.response.data);
          reject({
            customError: true,
            msg: error.response.data.reason.replace(/'/g, "`"),
            payload: JSON.stringify(payload),
            response: JSON.stringify(error.response.data).replace(/'/g, "`"),
          });
        });
    } catch (error) {
      console.log("error:createInvoice:main:catch", error);
      reject({
        customError: true,
        msg: "Netsuit AR Api Failed",
        response: "",
      });
    }
  });
}

/**
 * Update data
 * @param {*} connections
 * @param {*} item
 */
async function updateAPandAr(item, internal_id, processed = "P") {
  try {
    console.log("updateAPandAr", item[0], internal_id, processed);

    const query1 = `
                  UPDATE dw_uat.interface_ar_intracompany set 
                  processed = '${processed}', 
                  processed_date = '${today}',
                  internal_id = ${internal_id == null ? null : "'" + internal_id + "'"
      }
                  where invoice_nbr = '${item[0].invoice_nbr}' or 
                  housebill_nbr = '${item[0].housebill_nbr}';
                `;
    console.log("query1", query1);
    await connections.query(query1);
    const query2 = `
                UPDATE dw_uat.interface_ap_intracompany set 
                processed = '${processed}', 
                processed_date = '${today}',
                internal_id = ${internal_id == null ? null : "'" + internal_id + "'"
      }
                where invoice_nbr = '${item[0].invoice_nbr}' or 
                housebill_nbr = '${item[0].housebill_nbr}';
              `;
    console.log("query2", query2);
    await connections.query(query2);
  } catch (error) {
    console.log("error:updateAPandAr", error);
    return {};
    await sendDevNotification(
      "INVOICE-INTERCOMPANY",
      "CW",
      "netsuite_intercompany updateAPandAr",
      item,
      error
    );
  }
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
