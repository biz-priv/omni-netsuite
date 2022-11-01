const nodemailer = require("nodemailer");
const moment = require("moment");
const { parse } = require("json2csv");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const { getConnection } = require("../Helpers/helper");

let sourceSystem = "";
let ssType = ""; // AP/ AR

module.exports.handler = async (event, context, callback) => {
  try {
    console.log("event", event);
    // event = { source_system: "WT", ss_type: "AR" };
    sourceSystem = event.source_system;
    ssType = event.ss_type;
    const dataList = {
      WT: {
        sql: "",
      },
      CW: {
        sql: "",
      },
      M1: {
        sql: "",
      },
      TR: {
        sql: "",
      },
    };
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
    const filename = `Netsuite-${sourceSystem}-${ssType}-${
      process.env.STAGE
    }-report-${moment().format("DD-MM-YYYY")}.csv`;
    await sendMail(filename, csv);

    return "completed";
  } catch (error) {
    console.log("error", error);
    return "Failed";
  }
  // var lambda = new aws.Lambda({
  //   region: 'us-west-2' //change to your region
  // });

  // lambda.invoke({
  //   FunctionName: 'name_of_your_lambda_function',
  //   Payload: JSON.stringify(event, null, 2) // pass params
  // }, function(error, data) {
  //   if (error) {
  //     context.done('error', error);
  //   }
  //   if(data.Payload){
  //    context.succeed(data.Payload)
  //   }
  // });
};

async function getReportData(connections) {
  try {
    const query = `select source_system,file_nbr,customer_id,subsidiary,invoice_nbr,invoice_date,housebill_nbr,invoice_type,handling_stn,charge_cd,charge_cd_internal_id,currency,total,intercompany,error_msg
                    from interface_ar_api_logs where source_system = 'TR'`;

    return await connections.query(query);
  } catch (error) {
    console.log("error", error);
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
      const title = `Netsuite ${sourceSystem} ${ssType} Report ${process.env.STAGE.toUpperCase()}`;
      const message = {
        from: `${title} <${process.env.NETSUIT_AR_ERROR_EMAIL_FROM}>`,
        // to: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
        to: "kazi.ali@bizcloudexperts.com",
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
