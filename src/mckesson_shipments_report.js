const nodemailer = require("nodemailer");
const moment = require("moment");
const { parse } = require("json2csv");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const { getConnection } = require("../Helpers/helper");

module.exports.handler = async (event, context, callback) => {
  try {
    /**
     * Get connections
     */
    const connections = dbc(getConnection(process.env));
    const data = await getReportData(connections);
    if (data.length == 0) return;

    /**
     * create csv
     */
    const fields = Object.keys(data[0]);
    const opts = { fields };
    const csv = parse(data, opts);

    /**
     * send mail
     */
    const filename = `mckesson-shipments-report-${moment().format(
      "DD-MM-YYYY"
    )}.csv`;
    await sendMail(filename, csv);

    return "completed";
  } catch (error) {
    return "Failed";
  }
};

async function getReportData(connections) {
  try {
    const query = `select
                    a.file_nbr ,
                    a.house_bill_nbr ,
                    a.shipper_name,
                    a.consignee_name ,
                    a.consignee_addr_1 ,
                    a.consignee_addr_2 ,
                    a.consignee_city ,
                    a.consignee_st ,
                    a.consignee_zip ,
                    ref.ref_nbr as consignee_Ref,
                    a.current_status ,
                    a.pod_name ,
                    a.pod_date ,
                    a.file_date,
                    a.schd_delv_date ,
                    b.description
                    from shipment_info a
                    join priority_code b
                    on a.priority_code = b.priority_code
                    left outer join
                    (
                    select distinct source_system ,file_nbr ,
                    listagg(distinct ref_nbr  ,',') within group (order by pk_ref_nbr desc) AS ref_nbr
                    from shipment_ref
                    where customer_type = 'C'
                    and ref_typeid = 'REF'
                    group by source_system ,file_nbr
                    )ref
                    on a.file_nbr = ref.file_nbr
                    and a.source_system = ref.source_system
                    where bill_to_nbr = '21719' or cntrl_cust_nbr = '21719'
                    and a.source_system = 'WT'`;

    const result = await connections.query(query);
    return result;
  } catch (error) {
    throw "No data found.";
  }
}

function sendMail(filename, content) {
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

      const message = {
        from: `McKesson Shipments Report <${process.env.NETSUIT_AR_ERROR_EMAIL_FROM}>`,
        // to: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
        to: "kazi.ali@bizcloudexperts.com,kiranv@bizcloudexperts.com",
        // to: "kazi.ali@bizcloudexperts.com",
        subject: `McKesson Shipments Report ${process.env.STAGE.toUpperCase()}`,
        attachments: [{ filename, content }],
        html: `
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta http-equiv="X-UA-Compatible" content="IE=edge">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title> McKesson Shipments Report </title>
          </head>
          <body>
            <p> McKesson Shipments Report (${moment().format("DD-MM-YYYY")})</p>
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
