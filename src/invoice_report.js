const nodemailer = require("nodemailer");
const moment = require("moment");
const { parse } = require("json2csv");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const {
  getConnection,
  sendDevNotification,
  getConnectionToRds,
} = require("../Helpers/helper");
const mailList = {
  WT: {
    AR: process.env.NETSUIT_AR_ERROR_EMAIL_TO,
    AP: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
  },
  CW: {
    AR: process.env.NETSUIT_AR_ERROR_EMAIL_TO,
    AP: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
  },
  M1: {
    AR: process.env.NETSUIT_AR_ERROR_EMAIL_TO,
    AP: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
  },
  TR: {
    AR: process.env.NETSUIT_AR_TR_ERROR_EMAIL_TO,
    AP: process.env.NETSUIT_AP_TR_ERROR_EMAIL_TO,
  },
  OL: {
    AR: process.env.NETSUIT_AR_ERROR_EMAIL_TO,
    AP: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
  },
  INTERCOMPANY: {
    CW: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
    TR:
      process.env.NETSUIT_AP_ERROR_EMAIL_TO + ",natalief.hkg@trinityworld.com",
  },
};

module.exports.handler = async (event, context, callback) => {
  let sourceSystem = "",
    reportType = "";
  try {
    console.log(event);
    let connections = "";

    const eventData = event.invPayload.split("_");
    sourceSystem = eventData[0];
    reportType = eventData[1];

    if (["OL"].includes(sourceSystem)) {
      connections = await getConnectionToRds(process.env);
    } else {
      connections = dbc(getConnection(process.env));
    }

    if (reportType === "AR") {
      await generateCsvAndMail(connections, sourceSystem, "AR");
    } else if (reportType === "AP") {
      await generateCsvAndMail(connections, sourceSystem, "AP");
    } else {
      await generateCsvAndMail(connections, sourceSystem, "INTERCOMPANY", "AP");
      await generateCsvAndMail(connections, sourceSystem, "INTERCOMPANY", "AR");
    }
    return "Success";
  } catch (error) {
    console.log("error", error);
    await sendDevNotification(
      "INVOICE-REPOR-" + sourceSystem,
      reportType,
      "invoice_report main fn",
      event.invPayload,
      error
    );
    return "Failed";
  }
};

async function generateCsvAndMail(
  connections,
  sourceSystem,
  type,
  intercompanyType = null
) {
  try {
    const data = await getReportData(
      connections,
      sourceSystem,
      type,
      intercompanyType
    );
    if (!data || data.length == 0) return;
    /**
     * create csv
     */
    const fields = Object.keys(data[0]);
    const opts = { fields };
    const csv = parse(data, opts);

    /**
     * send mail
     */
    const filename = `Netsuite-${sourceSystem}-${type}-${
      process.env.STAGE
    }-report-${moment().format("DD-MM-YYYY")}.csv`;
    await sendMail(filename, csv, sourceSystem, type, intercompanyType);

    /**
     * Update rows
     */
    const maxId = Math.max(...data.map((e) => e.id));
    console.log("sourceSystem, type, maxId", sourceSystem, type, maxId);
    if (intercompanyType === null || intercompanyType === "AR") {
      await updateReportData(connections, sourceSystem, type, maxId);
    }
  } catch (error) {
    console.log("error:generateCsvAndMail", error);
    await sendDevNotification(
      "INVOICE-REPOR-" + sourceSystem,
      "type value:- " +
        type +
        "and intercompanyType value:-" +
        intercompanyType,
      "invoice_report generateCsvAndMail",
      {},
      error
    );
  }
}
async function executeQuery(connections, sourceSystem, queryData) {
  try {
    if (["OL"].includes(sourceSystem)) {
      const [rows] = await connections.execute(queryData);
      return rows;
    } else {
      return await connections.query(queryData);
    }
  } catch (error) {
    throw error;
  }
}

async function getReportData(
  connections,
  sourceSystem,
  type,
  intercompanyType
) {
  try {
    let query = "";
    if (type === "AP") {
      // AP
      const table = ["OL"].includes(sourceSystem)
        ? "dw_uat.interface_ap_api_logs"
        : "interface_ap_api_logs";
      const queryNonVenErr = `select source_system,error_msg,file_nbr,vendor_id,subsidiary,invoice_nbr,invoice_date,housebill_nbr,master_bill_nbr,invoice_type,controlling_stn,currency,charge_cd,total,posted_date,gc_code,tax_code,unique_ref_nbr,internal_ref_nbr,intercompany,id
              from ${table} where source_system = '${sourceSystem}' and is_report_sent ='N' and 
              error_msg NOT LIKE '%Vendor not found%'`;

      const nonVenErrdata = await executeQuery(
        connections,
        sourceSystem,
        queryNonVenErr
      );
      console.log("nonVenErrdata", nonVenErrdata.length);
      const queryVenErr = `select vendor_id from ${table} where source_system = '${sourceSystem}' 
                          and is_report_sent ='N' and error_msg LIKE '%Vendor not found%'`;
      const querySelectors = `ia.subsidiary, iam.source_system, 'Vendor not found. (vendor_id: '||iam.vendor_id||') Subsidiary: '||ia.subsidiary as error_msg`;
      let mainQuery = "";
      if (sourceSystem == "TR") {
        mainQuery = ` SELECT iam.invoice_nbr, iam.vendor_id, count(ia.*) as tc, iam.invoice_type, ia.gc_code, ${querySelectors}
        FROM interface_ap_master iam
        LEFT JOIN interface_ap ia ON 
        iam.invoice_nbr = ia.invoice_nbr and 
        iam.invoice_type = ia.invoice_type and 
        iam.vendor_id = ia.vendor_id and 
        iam.gc_code = ia.gc_code and 
        iam.source_system = ia.source_system and 
        iam.file_nbr = ia.file_nbr 
        where iam.source_system = '${sourceSystem}' and iam.processed ='F' and iam.vendor_id in (${queryVenErr}) 
        GROUP BY iam.invoice_nbr, iam.vendor_id, iam.invoice_type, ia.gc_code, ia.subsidiary, iam.source_system`;
      } else if (sourceSystem == "WT") {
        mainQuery = `SELECT iam.invoice_nbr, iam.vendor_id, count(ia.*) as tc, iam.invoice_type, ${querySelectors}
        FROM interface_ap_master iam
        LEFT JOIN interface_ap ia ON 
        iam.invoice_nbr = ia.invoice_nbr and 
        iam.invoice_type = ia.invoice_type and 
        iam.vendor_id = ia.vendor_id and 
        iam.gc_code = ia.gc_code and 
        iam.source_system = ia.source_system and 
        iam.file_nbr = ia.file_nbr 
        where iam.source_system = '${sourceSystem}' and iam.processed ='F' and iam.vendor_id in (${queryVenErr}) 
        GROUP BY iam.invoice_nbr, iam.vendor_id, iam.invoice_type, ia.subsidiary, iam.source_system;`;
      } else if (sourceSystem == "CW") {
        mainQuery = `SELECT iam.invoice_nbr, iam.vendor_id, count(ia.*) as tc, iam.invoice_type, ia.gc_code, ${querySelectors} 
        FROM interface_ap_master_cw iam
        LEFT JOIN interface_ap_cw ia ON 
        iam.invoice_nbr = ia.invoice_nbr and 
        iam.invoice_type = ia.invoice_type and 
        iam.vendor_id = ia.vendor_id and 
        iam.gc_code = ia.gc_code and 
        iam.source_system = ia.source_system and 
        iam.file_nbr = ia.file_nbr
        where iam.source_system = '${sourceSystem}' and iam.processed ='F' and iam.vendor_id in (${queryVenErr})  
        GROUP BY iam.invoice_nbr, iam.vendor_id, iam.invoice_type, ia.gc_code, ia.subsidiary, iam.source_system;`;
      } else if (sourceSystem == "M1") {
        mainQuery = `SELECT iam.invoice_nbr, iam.vendor_id, count(ia.*) as tc, iam.invoice_type,${querySelectors}
        FROM interface_ap_master iam
        LEFT JOIN interface_ap ia ON
        iam.invoice_nbr = ia.invoice_nbr and
        iam.invoice_type = ia.invoice_type and
        iam.vendor_id = ia.vendor_id and
        iam.gc_code = ia.gc_code and
        iam.source_system = ia.source_system and
        iam.file_nbr = ia.file_nbr
        where iam.source_system = '${sourceSystem}' and iam.processed ='F' and iam.vendor_id in (${queryVenErr})
        GROUP BY iam.invoice_nbr, iam.vendor_id, iam.invoice_type, ia.subsidiary, iam.source_system;`;
      } else if (sourceSystem == "OL") {
        mainQuery = `select distinct invoice_nbr,vendor_id, invoice_type, file_nbr, subsidiary, source_system, CONCAT('Vendor not found. (vendor_id: ', CAST(vendor_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
        from dw_uat.interface_ap where source_system = '${sourceSystem}' and processed ='F' and vendor_id in (${queryVenErr})`;
      }

      console.log("mainQuery", mainQuery);
      const data = await executeQuery(connections, sourceSystem, mainQuery);
      console.log("data", data.length);
      if (data && data.length > 0) {
        const formatedData = data.map((e) => ({
          source_system: e?.source_system ?? "",
          error_msg: e?.error_msg ?? "",
          file_nbr: e?.file_nbr ?? "",
          vendor_id: e?.vendor_id ?? "",
          subsidiary: e?.subsidiary ?? "",
          invoice_nbr: e?.invoice_nbr ?? "",
          invoice_date: e?.invoice_date ?? "",
          housebill_nbr: e?.housebill_nbr ?? "",
          master_bill_nbr: e?.master_bill_nbr ?? "",
          invoice_type: e?.invoice_type ?? "",
          controlling_stn: e?.controlling_stn ?? "",
          currency: e?.currency ?? "",
          charge_cd: e?.charge_cd ?? "",
          total: e?.total ?? "",
          posted_date: e?.posted_date ?? "",
          gc_code: e?.gc_code ?? "",
          tax_code: e?.tax_code ?? "",
          unique_ref_nbr: e?.unique_ref_nbr ?? "",
          internal_ref_nbr: e?.internal_ref_nbr ?? "",
          intercompany: e?.intercompany ?? "",
          id: e?.id ?? "",
        }));
        return [...formatedData, ...nonVenErrdata];
      } else {
        return nonVenErrdata;
      }
    } else if (type === "AR") {
      // AR
      const table = ["OL"].includes(sourceSystem)
        ? "dw_uat.interface_ar_api_logs"
        : "interface_ar_api_logs";
      const queryNonCuErr = `select source_system,error_msg,file_nbr,customer_id,subsidiary,invoice_nbr,invoice_date,housebill_nbr,master_bill_nbr,invoice_type,controlling_stn,charge_cd,curr_cd,total,posted_date,gc_code,tax_code,unique_ref_nbr,internal_ref_nbr,order_ref,ee_invoice,intercompany,id 
              from ${table} where source_system = '${sourceSystem}' and is_report_sent ='N' and 
              error_msg NOT LIKE '%Customer not found%'`;
      const nonCuErrdata = await executeQuery(
        connections,
        sourceSystem,
        queryNonCuErr
      );
      console.log("nonCuErrdata", nonCuErrdata.length);

      const queryCuErr = `select customer_id from ${table} where source_system = '${sourceSystem}' 
                          and is_report_sent ='N' and error_msg LIKE '%Customer not found%'`;
      const querySelectors = `subsidiary, source_system, CONCAT('Customer not found. (customer_id: ', CAST(customer_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg`;
      let mainQuery = "";
      if (sourceSystem == "TR") {
        mainQuery = `select distinct invoice_nbr,customer_id,invoice_type, gc_code, ${querySelectors}
        from interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})`;
      } else if (sourceSystem == "WT") {
        mainQuery = `select distinct invoice_nbr,invoice_type, ${querySelectors}
        from interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})`;
      } else if (sourceSystem == "CW") {
        mainQuery = `select distinct invoice_nbr,customer_id,invoice_type, gc_code, ${querySelectors}
        from interface_ar_cw where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})`;
      } else if (sourceSystem == "M1") {
        mainQuery = `select distinct invoice_nbr,invoice_type, ${querySelectors}
        from interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})`;
      } else if (sourceSystem == "OL") {
        mainQuery = `select distinct invoice_nbr, invoice_type, file_nbr, ${querySelectors}
        from dw_uat.interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})`;
      }
      console.log("mainQuery", mainQuery);
      const data = await executeQuery(connections, sourceSystem, mainQuery);
      console.log("data", data.length);
      if (data && data.length > 0) {
        const formatedData = data.map((e) => ({
          source_system: e?.source_system ?? "",
          error_msg: e?.error_msg ?? "",
          file_nbr: e?.file_nbr ?? "",
          customer_id: e?.customer_id ?? "",
          subsidiary: e?.subsidiary ?? "",
          invoice_nbr: e?.invoice_nbr ?? "",
          invoice_date: e?.invoice_date ?? "",
          housebill_nbr: e?.housebill_nbr ?? "",
          master_bill_nbr: e?.master_bill_nbr ?? "",
          invoice_type: e?.invoice_type ?? "",
          controlling_stn: e?.controlling_stn ?? "",
          charge_cd: e?.charge_cd ?? "",
          curr_cd: e?.curr_cd ?? "",
          total: e?.total ?? "",
          posted_date: e?.posted_date ?? "",
          gc_code: e?.gc_code ?? "",
          tax_code: e?.tax_code ?? "",
          unique_ref_nbr: e?.unique_ref_nbr ?? "",
          internal_ref_nbr: e?.internal_ref_nbr ?? "",
          order_ref: e?.order_ref ?? "",
          ee_invoice: e?.ee_invoice ?? "",
          intercompany: e?.intercompany ?? "",
          id: e?.id ?? "",
        }));
        return [...formatedData, ...nonCuErrdata];
      } else {
        return nonCuErrdata;
      }
    } else {
      // INTERCOMPANY
      if (sourceSystem === "CW") {
        if (intercompanyType === "AP") {
          query = `                             
          select distinct ap.*,apm.processed ,apm.intercompany_processed,apm.vendor_internal_id, ial.error_msg, ial.id 
          from public.interface_ap_cw ap
          join public.interface_ap_master_cw apm 
          on ap.invoice_nbr =apm.invoice_nbr
          and ap.vendor_id =apm.vendor_id and ap.invoice_type =apm.invoice_type
          join interface_intercompany_api_logs ial on ial.source_system = apm.source_system 
          and ial.ap_internal_id = apm.internal_id and ial.file_nbr = apm.file_nbr 
          where ap.intercompany ='Y' and ial.source_system ='CW' and ial.is_report_sent ='N'`;
        } else {
          query = `                             
            select distinct ar.*, ial.error_msg, ial.id 
            from public.interface_ar_cw ar
            join interface_intercompany_api_logs ial on ial.source_system = ar.source_system 
            and ial.ar_internal_id  = ar.internal_id and ial.file_nbr = ar.file_nbr 
            where ar.intercompany ='Y' and ial.source_system ='CW' and ial.is_report_sent ='N'`;
        }
      } else if (sourceSystem === "TR") {
        if (intercompanyType === "AP") {
          query = `                             
          select distinct ap.*,apm.processed ,apm.intercompany_processed,apm.vendor_internal_id, ial.error_msg, ial.id 
          from public.interface_ap ap
          join public.interface_ap_master apm 
          on ap.invoice_nbr =apm.invoice_nbr
          and ap.vendor_id =apm.vendor_id and ap.invoice_type =apm.invoice_type
          join interface_intercompany_api_logs ial on ial.source_system = apm.source_system 
          and ial.ap_internal_id = apm.internal_id and ial.file_nbr = apm.file_nbr 
          where ap.intercompany ='Y' and ial.source_system ='TR' and ial.is_report_sent ='N'`;
        } else {
          query = `                             
            select distinct ar.*, ial.error_msg, ial.id
            from public.interface_ar ar
            join interface_intercompany_api_logs ial on ial.source_system = ar.source_system 
            and ial.ar_internal_id  = ar.internal_id and ial.file_nbr = ar.file_nbr 
            where ar.intercompany ='Y' and ial.source_system ='TR' and ial.is_report_sent ='N'`;
        }
      }

      console.log("query:getReportData", query);
      const data = await executeQuery(connections, sourceSystem, query);
      console.log("query:data", data.length);
      if (data && data.length > 0) {
        return data.map((e) => ({
          source_system: e.source_system,
          error_msg: e.error_msg,
          ...e,
        }));
      } else {
        return [];
      }
    }
  } catch (error) {
    console.log("error:getReportData", error);
    return [];
  }
}

async function updateReportData(connections, sourceSystem, type, maxId) {
  try {
    let table = "";
    if (type === "AP") {
      table = ["OL"].includes(sourceSystem)
        ? "dw_uat.interface_ap_api_logs"
        : "interface_ap_api_logs";
    } else if (type === "AR") {
      table = ["OL"].includes(sourceSystem)
        ? "dw_uat.interface_ar_api_logs"
        : "interface_ar_api_logs";
    } else {
      table = "interface_intercompany_api_logs";
    }
    const query = `Update ${table} set 
                  is_report_sent ='P', 
                  report_sent_time = '${moment().format("YYYY-MM-DD H:m:s")}' 
                  where source_system = '${sourceSystem}' and is_report_sent ='N' and id <= ${maxId}`;
    console.log("query", query);
    return await executeQuery(connections, sourceSystem, query);
  } catch (error) {
    console.log("error:updateReportData", error);
    throw error;
  }
}

function sendMail(
  filename,
  content,
  sourceSystem,
  type,
  intercompanyType = null
) {
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
      const title = `Netsuite ${sourceSystem} ${type} ${
        intercompanyType ? intercompanyType : ""
      } Report ${process.env.STAGE.toUpperCase()}`;

      const message = {
        from: `${title} <${process.env.NETSUIT_AR_ERROR_EMAIL_FROM}>`,
        // to: "abdul.rashed@bizcloudexperts.com,iqbal.layek@bizcloudexperts.com",
        to:
          type === "INTERCOMPANY"
            ? mailList[type][sourceSystem]
            : mailList[sourceSystem][type],
        subject: title,
        attachments: [{ filename, content }],
        html: `
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta http-equiv="X-UA-Compatible" content="IE=edge">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title> ${title} </title>
          </head>
          <body>
            <p> ${title} (${moment().format("DD-MM-YYYY")})</p>
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
