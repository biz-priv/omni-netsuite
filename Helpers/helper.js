const moment = require("moment");
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

/**
 * handle error logs
 */
async function createARFailedRecords(connections, item, error) {
  try {
    const formatData = {
      source_system: item?.source_system ?? null,
      file_nbr: item?.file_nbr ?? null,
      customer_id: item?.customer_id ?? null,
      subsidiary: item?.subsidiary ?? null,
      invoice_nbr: item?.invoice_nbr ?? null,
      invoice_date:
        item?.invoice_date && moment(item?.invoice_date).isValid()
          ? "'" + moment(item?.invoice_date).format("YYYY-MM-DD HH:mm:ss") + "'"
          : null,
      housebill_nbr: item?.housebill_nbr ?? null,
      invoice_type: item?.invoice_type ?? null,
      handling_stn: item?.handling_stn ?? null,
      charge_cd: item?.charge_cd ?? null,
      charge_cd_internal_id: item?.charge_cd_internal_id ?? null,
      currency: item?.currency ?? null,
      total: item?.total ?? null,
      intercompany: item?.intercompany ?? null,
      error_msg: error?.msg + " Subsidiary: " + item.subsidiary,
      response: error?.response ?? null,
      payload: null,
    };
    // console.log("formatData", formatData);
    const query = `
      INSERT INTO interface_ar_api_logs 
      (source_system, file_nbr, customer_id, subsidiary, invoice_nbr, invoice_date, housebill_nbr, invoice_type, 
        handling_stn, charge_cd, charge_cd_internal_id, currency, total, intercompany, error_msg, response, 
        payload )
      VALUES ('${formatData.source_system}', '${formatData.file_nbr}', '${formatData.customer_id}', '${formatData.subsidiary}', 
              '${formatData.invoice_nbr}', ${formatData.invoice_date}, '${formatData.housebill_nbr}', '${formatData.invoice_type}', 
              '${formatData.handling_stn}', '${formatData.charge_cd}', '${formatData.charge_cd_internal_id}', '${formatData.currency}', 
              '${formatData.total}', '${formatData.intercompany}', '${formatData.error_msg}', '${formatData.response}', '${formatData.payload}');
    `;
    // console.log("query", query);
    await connections.query(query);
  } catch (error) {
    console.log("createARFailedRecords:error", error);
  }
}

/**
 * handle error logs
 */
async function createAPFailedRecords(connections, item, error) {
  try {
    const formatData = {
      source_system: item?.source_system ?? null,
      file_nbr: item?.file_nbr ?? null,
      vendor_id: item?.vendor_id ?? null,
      subsidiary: item?.subsidiary ?? null,
      invoice_nbr: item?.invoice_nbr ?? null,
      invoice_date:
        item?.invoice_date && moment(item?.invoice_date).isValid()
          ? "'" + moment(item?.invoice_date).format("YYYY-MM-DD HH:mm:ss") + "'"
          : null,
      housebill_nbr: item?.housebill_nbr ?? null,
      invoice_type: item?.invoice_type ?? null,
      handling_stn: item?.handling_stn ?? null,
      charge_cd: item?.charge_cd ?? null,
      charge_cd_internal_id: item?.charge_cd_internal_id ?? null,
      currency: item?.currency ?? null,
      total: item?.total ?? null,
      intercompany: item?.intercompany ?? null,
      error_msg: error?.msg + " Subsidiary: " + item.subsidiary,
      response: error?.response ?? null,
      payload: null,
    };
    // console.log("formatData", formatData);
    const query = `
      INSERT INTO interface_ap_api_logs 
      (source_system, file_nbr, vendor_id, subsidiary, invoice_nbr, invoice_date, housebill_nbr, invoice_type, 
        handling_stn, charge_cd, charge_cd_internal_id, currency, total, intercompany, error_msg, response, 
        payload )
      VALUES ('${formatData.source_system}', '${formatData.file_nbr}', '${formatData.vendor_id}', '${formatData.subsidiary}', 
              '${formatData.invoice_nbr}', ${formatData.invoice_date}, '${formatData.housebill_nbr}', '${formatData.invoice_type}', 
              '${formatData.handling_stn}', '${formatData.charge_cd}', '${formatData.charge_cd_internal_id}', '${formatData.currency}', 
              '${formatData.total}', '${formatData.intercompany}', '${formatData.error_msg}', '${formatData.response}', '${formatData.payload}');
    `;
    // console.log("query", query);
    await connections.query(query);
  } catch (error) {
    console.log("createAPFailedRecords:error", error);
  }
}
module.exports = {
  getConfig,
  getConnection,
  createARFailedRecords,
  createAPFailedRecords,
};
