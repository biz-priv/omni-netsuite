const nodemailer = require("nodemailer");
const moment = require("moment");
const { parse } = require("json2csv");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const { getConnection } = require("../Helpers/helper");
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
  INTERCOMPANY: {
    CW: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
    TR: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
  },
};

module.exports.handler = async (event, context, callback) => {
  try {
    console.log(event);

    const connections = dbc(getConnection(process.env));
    const eventData = event.invPayload;
    const sourceSystem = eventData.split("_")[0];
    const reportType = eventData.split("_")[1];
    console.log(sourceSystem, reportType);

    if (reportType === "AR") {
      console.log("AR");
      await generateCsvAndMail(connections, sourceSystem, "AR");
    } else if (reportType === "AP") {
      console.log("AP");
      await generateCsvAndMail(connections, sourceSystem, "AP");
    } else {
      //intercompany
      console.log("intercompany");
      await generateCsvAndMail(connections, sourceSystem, "INTERCOMPANY", "AP");
      await generateCsvAndMail(connections, sourceSystem, "INTERCOMPANY", "AR");
    }
    return "Success";
  } catch (error) {
    console.log("error", error);
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
      query = `select source_system,error_msg,file_nbr,vendor_id,subsidiary,invoice_nbr,invoice_date,housebill_nbr,master_bill_nbr,invoice_type,controlling_stn,currency,charge_cd,total,posted_date,gc_code,tax_code,unique_ref_nbr,internal_ref_nbr,intercompany,id
              from interface_ap_api_logs where source_system = '${sourceSystem}' and is_report_sent ='N'`;
    } else if (type === "AR") {
      // AR
      query = `select source_system,error_msg,file_nbr,customer_id,subsidiary,invoice_nbr,invoice_date,housebill_nbr,master_bill_nbr,invoice_type,controlling_stn,charge_cd,curr_cd,total,posted_date,gc_code,tax_code,unique_ref_nbr,internal_ref_nbr,order_ref,ee_invoice,intercompany,id 
              from interface_ar_api_logs where source_system = '${sourceSystem}' and is_report_sent ='N'`;
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
    }
    console.log("query:getReportData", query);
    const data = await connections.query(query);
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
  } catch (error) {
    console.log("error:getReportData", error);
    return [];
  }
}

async function updateReportData(connections, sourceSystem, type, maxId) {
  try {
    let table = "";
    if (type === "AP") {
      table = "interface_ap_api_logs";
    } else if (type === "AR") {
      table = "interface_ar_api_logs";
    } else {
      table = "interface_intercompany_api_logs";
    }
    const query = `Update ${table} set 
                  is_report_sent ='P', 
                  report_sent_time = '${moment().format("YYYY-MM-DD H:m:s")}' 
                  where source_system = '${sourceSystem}' and is_report_sent ='N' and id <= ${maxId}`;
    console.log("query", query);
    return await connections.query(query);
  } catch (error) {
    console.log("error:updateReportData", error);
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
        // to: "kazi.ali@bizcloudexperts.com,priyanka@bizcloudexperts.com,mish@bizcloudexperts.com,kiranv@bizcloudexperts.com,ashish.akshantal@bizcloudexperts.com",
        // to: "kazi.ali@bizcloudexperts.com",
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
