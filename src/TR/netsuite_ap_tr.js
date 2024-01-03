const AWS = require("aws-sdk");
const {SNS_TOPIC_ARN } = process.env;
const sns = new AWS.SNS({ region: process.env.REGION });
const { create, convert } = require("xmlbuilder2");
const crypto = require("crypto");
const axios = require("axios");
const nodemailer = require("nodemailer");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const payload = require("../../Helpers/netsuit_AP.json");
const lineItemPayload = require("../../Helpers/netsuit_line_items_AP.json");
const {
  getConfig,
  getConnection,
  createAPFailedRecords,
  triggerReportLambda,
  sendDevNotification,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");

let userConfig = "";
let connections = "";

const today = getCustomDate();
const lineItemPerProcess = 500;
let totalCountPerLoop = 20;
let queryOffset = 0;
let queryinvoiceType = "IN"; // IN / CM
let queryOperator = "<=";
let queryInvoiceId = null;
let queryInvoiceNbr = null;
let queryVendorId = null;
let queryGcCode = null;
const source_system = "TR";
let nextOffset = 0;

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);

  console.log("event", event);
  let currentCount = 0;
  totalCountPerLoop = event.hasOwnProperty("totalCountPerLoop")
    ? event.totalCountPerLoop
    : 20;
  queryOperator = event.hasOwnProperty("queryOperator")
    ? event.queryOperator
    : "<=";

  queryInvoiceId = event.hasOwnProperty("queryInvoiceId")
    ? event.queryInvoiceId
    : null;

  queryInvoiceNbr = event.hasOwnProperty("queryInvoiceNbr")
    ? event.queryInvoiceNbr
    : null;

  queryOffset = event.hasOwnProperty("queryOffset") ? event.queryOffset : 0;

  queryinvoiceType = event.hasOwnProperty("queryinvoiceType")
    ? event.queryinvoiceType
    : "IN";

  queryVendorId = event.hasOwnProperty("queryVendorId")
    ? event.queryVendorId
    : null;

  queryGcCode = event.hasOwnProperty("queryGcCode") ? event.queryGcCode : null;

  nextOffset = event.hasOwnProperty("nextOffsetCount")
    ? event.nextOffsetCount
    : 0;
  const nextOffsetCount = nextOffset + totalCountPerLoop + 1;

  try {
    /**
     * Get connections
     */
    connections = dbc(getConnection(process.env));

    //process invoicess having > 500 line items
    if (queryOperator == ">") {
      // if = create else = Update with 500 line items.
      console.log("> start");
      totalCountPerLoop = 0;
      if (queryInvoiceId != null && queryInvoiceId.length > 0) {
        //update the main invoice with 500 line items each time
        console.log(">if");

        try {
          const invoiceDataList = await getInvoiceNbrData(
            connections,
            queryInvoiceNbr,
            true
          );
          await createInvoiceAndUpdateLineItems(
            queryInvoiceId,
            invoiceDataList
          );

          if (lineItemPerProcess >= invoiceDataList.length) {
            throw "Next Process";
          } else {
            dbc.end();
            return {
              hasMoreData: "true",
              queryOperator,
              queryOffset: queryOffset + lineItemPerProcess + 1,
              queryInvoiceId,
              queryInvoiceNbr,
              queryinvoiceType,
              queryVendorId,
              queryGcCode,
            };
          }
        } catch (error) {
          dbc.end();
          return {
            hasMoreData: "true",
            queryOperator,
          };
        }
      } else {
        //Create the main invoice with 500 line items 1st
        console.log("> else");

        try {
          let invoiceDataList = [];
          let orderData = [];
          try {
            orderData = await getDataGroupBy(connections);
            console.log("orderData", orderData.length);
          } catch (error) {
            dbc.end();
            await triggerReportLambda(
              process.env.NETSUIT_INVOICE_REPORT,
              "TR_AP"
            );
            await startNextStep();
            return { hasMoreData: "false" };
          }
          queryInvoiceNbr = orderData[0].invoice_nbr;
          queryVendorId = orderData[0].vendor_id;
          queryGcCode = orderData[0].gc_code;
          queryinvoiceType = orderData[0].invoice_type;

          invoiceDataList = await getInvoiceNbrData(
            connections,
            queryInvoiceNbr,
            true
          );
          console.log("invoiceDataList", invoiceDataList.length);
          /**
           * set queryInvoiceId in this process and return update query
           */
          const queryData = await mainProcess(orderData[0], invoiceDataList);
          // console.log("queryData", queryData);
          await updateInvoiceId(connections, queryData);

          /**
           * if items <= 501 process next invoice
           * or send data for next update process of same invoice.
           */
          if (
            invoiceDataList.length <= lineItemPerProcess ||
            queryInvoiceId == null
          ) {
            throw "Next Invoice";
          } else {
            dbc.end();
            return {
              hasMoreData: "true",
              queryOperator,
              queryOffset: queryOffset + lineItemPerProcess + 1,
              queryInvoiceId,
              queryInvoiceNbr: queryInvoiceNbr,
              queryinvoiceType: orderData[0].invoice_type,
              queryVendorId,
              queryGcCode,
            };
          }
        } catch (error) {
          console.log("error", error);
          dbc.end();
          return {
            hasMoreData: "true",
            queryOperator,
          };
        }
      }
    } else {
      //Create invoices with 500 line items 1st
      /**
       * Get data from db
       */
      let invoiceDataList = [];
      let orderData = [];
      let invoiceIDs = [];
      try {
        orderData = await getDataGroupBy(connections);
      } catch (error) {
        return {
          hasMoreData: "true",
          queryOperator: queryOperator == "<=" ? ">" : "<=",
        };
      }

      try {
        invoiceIDs = orderData.map((a) => "'" + a.invoice_nbr + "'");
        console.log("orderData**", orderData.length);
        currentCount = orderData.length;
        invoiceDataList = await getInvoiceNbrData(connections, invoiceIDs);
      } catch (error) {
        console.log("error:getInvoiceNbrData:try:catch", error);
        console.log(
          "invoiceIDs:try:catch found on getDataGroupBy but not in getInvoiceNbrData",
          invoiceIDs
        );
        return {
          hasMoreData: "true",
          queryOperator,
        };
      }
      /**
       * 15 simultaneous process
       */
      const perLoop = 15;
      let queryData = "";
      for (let index = 0; index < (orderData.length + 1) / perLoop; index++) {
        let newArray = orderData.slice(
          index * perLoop,
          index * perLoop + perLoop
        );
        const data = await Promise.all(
          newArray.map(async (item) => {
            return await mainProcess(item, invoiceDataList);
          })
        );
        queryData += data.join("");
      }

      /**
       * Updating total 20 invoices at once
       */
      await updateInvoiceId(connections, queryData);
      dbc.end();
      if (currentCount < totalCountPerLoop) {
        return { hasMoreData: "true", queryOperator: ">" };
      } else {
        return { hasMoreData: "true", queryOperator, nextOffsetCount };
      }
    }
  } catch (error) {
    dbc.end();
    await triggerReportLambda(process.env.NETSUIT_INVOICE_REPORT, "TR_AP");
    await startNextStep();
    const params = {
			Message: `Error in ${functionName}, Error: ${error.Message}`,
			TopicArn: SNS_TOPIC_ARN,
		};
    await sns.publish(params).promise();
    return { hasMoreData: "false" };
  }
};

/**
 * main process of netsuite AP API
 * @param {*} connections
 * @param {*} item
 */
async function mainProcess(item, invoiceDataList) {
  let singleItem = null;
  try {
    /**
     * get invoice obj from DB
     */
    const dataList = invoiceDataList.filter((e) => {
      return (
        e.invoice_nbr == item.invoice_nbr &&
        e.vendor_id == item.vendor_id &&
        e.invoice_type == item.invoice_type &&
        e.gc_code == item.gc_code
      );
    });

    let getUpdateQueryList = "";

    /**
     * set single item and customer data
     */
    singleItem = dataList[0];

    const vendorData = {
      entityId: singleItem.vendor_id,
      entityInternalId: singleItem.vendor_internal_id,
      currency: singleItem.currency,
      currencyInternalId: singleItem.currency_internal_id,
    };

    /**
     * Make Json to Xml payload
     */
    const xmlPayload = await makeJsonToXml(
      JSON.parse(JSON.stringify(payload)),
      dataList,
      vendorData
    );
    /**
     * create invoice
     */
    const invoiceId = await createInvoice(xmlPayload, singleItem.invoice_type);

    if (queryOperator == ">") {
      queryInvoiceId = invoiceId;
    }

    /**
     * update invoice id
     */
    const getQuery = getUpdateQuery(singleItem, invoiceId);
    getUpdateQueryList += getQuery;

    return getUpdateQueryList;
  } catch (error) {
    if (error.hasOwnProperty("customError")) {
      let getQuery = "";
      try {
        getQuery = getUpdateQuery(singleItem, null, false);
        if (error.hasOwnProperty("msg") && error.msg === "Unable to make xml") {
          return getQuery;
        }
        await createAPFailedRecords(connections, singleItem, error);
        return getQuery;
      } catch (error) {
        await createAPFailedRecords(connections, singleItem, error);
        return getQuery;
      }
    }
  }
}

/**
 * get data
 * @param {*} connections
 * @returns
 */
async function getDataGroupBy(connections) {
  try {
    // const dateCheckOperator = queryOperator == "<=" ? "<=" : "<";
    const dateCheckOperator = "<";
    const query = `
        SELECT iam.invoice_nbr, iam.vendor_id, count(ia.*) as tc, iam.invoice_type, ia.gc_code 
        FROM interface_ap_master iam
        LEFT JOIN interface_ap ia ON 
        iam.invoice_nbr = ia.invoice_nbr and 
        iam.invoice_type = ia.invoice_type and 
        iam.vendor_id = ia.vendor_id and 
        iam.gc_code = ia.gc_code and 
        iam.source_system = ia.source_system and 
        iam.file_nbr = ia.file_nbr 
        WHERE ((iam.internal_id is null and iam.processed != 'F' and iam.vendor_internal_id !='')
                OR (iam.vendor_internal_id !='' and iam.processed ='F' and 
                    iam.processed_date ${dateCheckOperator} '${today}' )
              )
              and ((iam.intercompany='Y' and iam.pairing_available_flag ='Y') OR 
                    iam.intercompany='N'
                  )
              and iam.source_system = '${source_system}' and iam.invoice_nbr != '' 
        GROUP BY iam.invoice_nbr, iam.vendor_id, iam.invoice_type, ia.gc_code 
        having tc ${queryOperator} ${lineItemPerProcess} 
        ORDER BY iam.invoice_nbr, iam.vendor_id, iam.invoice_type, ia.gc_code 
        limit ${totalCountPerLoop + 1} `;
    const result = await connections.query(query);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    throw "No data found.";
  }
}

async function getInvoiceNbrData(connections, invoice_nbr, isBigData = false) {
  try {
    let query = `SELECT ia.*, iam.vendor_internal_id ,iam.currency_internal_id  FROM interface_ap ia 
      left join interface_ap_master iam on 
      ia.invoice_nbr = iam.invoice_nbr and
      ia.invoice_type = iam.invoice_type and 
      ia.vendor_id = iam.vendor_id and 
      ia.gc_code = iam.gc_code and 
      ia.source_system = iam.source_system and 
      iam.file_nbr = ia.file_nbr 
      where ia.source_system = '${source_system}' and `;
    if (isBigData) {
      query += ` ia.invoice_nbr = '${invoice_nbr}' and ia.invoice_type = '${queryinvoiceType}' and iam.vendor_id ='${queryVendorId}' and iam.gc_code ='${queryGcCode}' 
      order by id limit ${lineItemPerProcess + 1} offset ${queryOffset}`;
    } else {
      query += ` ia.invoice_nbr in (${invoice_nbr.join(",")})`;
    }

    const result = await connections.query(query);
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.log("error", error);
    throw "getInvoiceNbrData: No data found.";
  }
}

function getOAuthKeys(configuration) {
  const res = {};
  res.account = configuration.account;
  res.consumerKey = configuration.token.consumer_key;
  res.tokenKey = configuration.token.token_key;

  res.nonce =
    Math.random().toString(36).substr(2, 15) +
    Math.random().toString(36).substr(2, 15);

  res.timeStamp = Math.round(new Date().getTime() / 1000);

  const key = `${configuration.token.consumer_secret}&${configuration.token.token_secret}`;

  const baseString =
    configuration.account +
    "&" +
    configuration.token.consumer_key +
    "&" +
    configuration.token.token_key +
    "&" +
    res.nonce +
    "&" +
    res.timeStamp;

  res.base64hash = crypto
    .createHmac("sha256", Buffer.from(key, "utf8"))
    .update(baseString)
    .digest(null, null)
    .toString("base64");
  return res;
}

async function makeJsonToXml(payload, data, vendorData) {
  try {
    const auth = getOAuthKeys(userConfig);

    const singleItem = data[0];
    const hardcode = getHardcodeData(
      singleItem?.intercompany == "Y" ? true : false
    );

    payload["soap:Envelope"]["soap:Header"] = {
      tokenPassport: {
        "@xmlns": "urn:messages_2021_2.platform.webservices.netsuite.com",
        account: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.account,
        },
        consumerKey: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.consumerKey,
        },
        token: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.tokenKey,
        },
        nonce: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.nonce,
        },
        timestamp: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.timeStamp,
        },
        signature: {
          "@algorithm": "HMAC_SHA256",
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.base64hash,
        },
      },
    };

    let recode = payload["soap:Envelope"]["soap:Body"]["add"]["record"];
    recode["q1:entity"]["@internalId"] = vendorData.entityInternalId; //This is internal ID for the customer.
    recode["q1:tranId"] = singleItem.invoice_nbr; //invoice ID
    recode["q1:tranDate"] = dateFormat(singleItem.invoice_date); //invoice date

    recode["q1:class"]["@internalId"] = hardcode.class.head;
    recode["q1:department"]["@internalId"] = hardcode.department.head;
    recode["q1:location"]["@internalId"] = hardcode.location.head;
    recode["q1:subsidiary"]["@internalId"] = singleItem.subsidiary;
    recode["q1:currency"]["@internalId"] = vendorData.currencyInternalId;

    recode["q1:otherRefNum"] = singleItem.customer_po; //customer_po is the bill to ref nbr
    recode["q1:memo"] = ""; // (leave out for worldtrak)

    if (singleItem.source_system == "TR" && singleItem.invoice_type == "IN") {
      recode["q1:approvalStatus"] = { "@internalId": "2" };
    }

    recode["q1:itemList"]["q1:item"] = data.map((e) => {
      return {
        "q1:taxCode": {
          "@internalId": e.tax_code_internal_id,
        },
        "q1:item": {
          "@internalId": e.charge_cd_internal_id,
        },
        "q1:description": e.charge_cd_desc,
        "q1:amount": e.total,
        "q1:rate": e.rate,
        "q1:department": {
          "@internalId": hardcode.department.line,
        },
        "q1:class": {
          "@internalId":
            hardcode.class.line[
              e.business_segment.split(":")[1].trim().toLowerCase()
            ],
        },
        "q1:location": {
          "@externalId": e.handling_stn,
        },
        "q1:customFieldList": {
          customField: [
            {
              "@internalId": "760",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.housebill_nbr ?? "",
            },
            {
              "@internalId": "1167",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.sales_person ?? "",
            },
            {
              "@internalId": "1727",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.master_bill_nbr ?? "",
            },
            {
              "@internalId": "1166",
              "@xsi:type": "SelectCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: { "@externalId": e.controlling_stn },
            },
            {
              "@internalId": "1168",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.ref_nbr ?? "",
            },
            {
              "@internalId": "2510", //prod:- 2510 dev:- 2506
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.consol_nbr ?? "",
            },
            {
              "@internalId": hardcode.finalizedbyInternalId,
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.finalizedby ?? "",
            },
          ],
        },
      };
    });

    recode["q1:customFieldList"]["customField"] = [
      {
        "@internalId": "1734",
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem?.internal_ref_nbr ?? "",
      },
      {
        "@internalId": "1730",
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem.file_nbr ?? "",
      },
      {
        "@internalId": "1744",
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem.email ?? "",
      },
      {
        "@internalId": "2327",
        "@xsi:type": "SelectCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: {
          "@typeId": "752",
          "@internalId": hardcode.source_system,
        },
      },
      {
        "@internalId": "1748",
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem.housebill_nbr ?? "",
      },
      {
        "@internalId": "1756",
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem.master_bill_nbr ?? "",
      },
      {
        "@internalId": "2673", //mode
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem?.mode_name ?? "",
      },
      {
        "@internalId": "2674", //service level
        "@xsi:type": "StringCustomFieldRef",
        "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
        value: singleItem?.service_level ?? "",
      },
    ];

    /**
     * check if IN or CM (IN => VendorBill , CM => VendorCredit)
     */

    recode["@xsi:type"] =
      singleItem.invoice_type == "IN" ? "q1:VendorBill" : "q1:VendorCredit";

    payload["soap:Envelope"]["soap:Body"]["add"]["record"] = recode;
    const doc = create(payload);
    return doc.end({ prettyPrint: true });
  } catch (error) {
    await sendDevNotification(
      source_system,
      "AP",
      "netsuite_ap_tr makeJsonToXml",
      data[0],
      error
    );
    throw {
      customError: true,
      msg: "Unable to make xml",
      data: data[0],
    };
  }
}

/**
 * Line Item XML
 * @param {*} internalId
 * @param {*} payload
 * @param {*} data
 * @returns
 */
async function makeJsonToXmlForLineItems(internalId, linePayload, data) {
  try {
    const auth = getOAuthKeys(userConfig);
    const singleItem = data[0];
    const hardcode = getHardcodeData(
      singleItem?.intercompany == "Y" ? true : false
    );
    linePayload["soap:Envelope"]["soap:Header"] = {
      tokenPassport: {
        "@xmlns": "urn:messages_2021_2.platform.webservices.netsuite.com",
        account: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.account,
        },
        consumerKey: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.consumerKey,
        },
        token: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.tokenKey,
        },
        nonce: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.nonce,
        },
        timestamp: {
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.timeStamp,
        },
        signature: {
          "@algorithm": "HMAC_SHA256",
          "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
          "#": auth.base64hash,
        },
      },
    };

    let recode = linePayload["soap:Envelope"]["soap:Body"]["update"]["record"];

    recode["q1:itemList"]["q1:item"] = data.map((e) => {
      return {
        "q1:taxCode": {
          "@internalId": e.tax_code_internal_id,
        },
        "q1:item": {
          "@internalId": e.charge_cd_internal_id,
        },
        "q1:description": e.charge_cd_desc,
        "q1:amount": e.total,
        "q1:rate": e.rate,
        "q1:department": {
          "@internalId": hardcode.department.line,
        },
        "q1:class": {
          "@internalId":
            hardcode.class.line[
              e.business_segment.split(":")[1].trim().toLowerCase()
            ],
        },
        "q1:location": {
          "@externalId": e.handling_stn,
        },
        "q1:customFieldList": {
          customField: [
            {
              "@internalId": "760",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.housebill_nbr ?? "",
            },
            {
              "@internalId": "1167",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.sales_person ?? "",
            },
            {
              "@internalId": "1727",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.master_bill_nbr ?? "",
            },
            {
              "@internalId": "1166",
              "@xsi:type": "SelectCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: { "@externalId": e.controlling_stn },
            },
            {
              "@internalId": "1168",
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.ref_nbr ?? "",
            },
            {
              "@internalId": "2510", //prod:- 2510 dev:- 2506
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.consol_nbr ?? "",
            },
            {
              "@internalId": hardcode.finalizedbyInternalId,
              "@xsi:type": "StringCustomFieldRef",
              "@xmlns": "urn:core_2021_2.platform.webservices.netsuite.com",
              value: e.finalizedby ?? "",
            },
          ],
        },
      };
    });

    /**
     * check if IN or CM (IN => Bill , CM => credit)
     */
    recode["@internalId"] = internalId;
    recode["@xsi:type"] =
      singleItem.invoice_type == "IN" ? "q1:VendorBill" : "q1:VendorCredit";

    linePayload["soap:Envelope"]["soap:Body"]["update"]["record"] = recode;
    const doc = create(linePayload);
    return doc.end({ prettyPrint: true });
  } catch (error) {
    await sendDevNotification(
      source_system,
      "AP",
      "netsuite_ap_tr makeJsonToXmlForLineItems",
      data[0],
      error
    );
    throw "Unable to make xml";
  }
}

/**
 * Create Invoice
 * @param {*} soapPayload
 * @param {*} type
 * @returns
 */
async function createInvoice(soapPayload, type) {
  try {
    const res = await axios.post(
      process.env.NETSUIT_AR_API_ENDPOINT,
      soapPayload,
      {
        headers: {
          Accept: "text/xml",
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: "add",
        },
      }
    );

    const obj = convert(res.data, { format: "object" });
    if (
      res.status == 200 &&
      obj["soapenv:Envelope"]["soapenv:Body"]["addResponse"]["writeResponse"][
        "platformCore:status"
      ]["@isSuccess"] == "true"
    ) {
      return obj["soapenv:Envelope"]["soapenv:Body"]["addResponse"][
        "writeResponse"
      ]["baseRef"]["@internalId"];
    } else if (res.status == 200) {
      throw {
        customError: true,
        msg: obj["soapenv:Envelope"]["soapenv:Body"]["addResponse"][
          "writeResponse"
        ]["platformCore:status"]["platformCore:statusDetail"][
          "platformCore:message"
        ],
        payload: soapPayload,
        response: res.data,
      };
    } else {
      throw {
        customError: true,
        msg:
          type == "IN"
            ? "Unable to create Vendor Bill. Internal Server Error"
            : "Unable to create Vendor Credit. Internal Server Error",
        payload: soapPayload,
        response: res.data,
      };
    }
  } catch (error) {
    if (error.hasOwnProperty("customError")) {
      throw error;
    } else {
      throw {
        msg: "Netsuit AP Api Failed",
      };
    }
  }
}

async function createInvoiceAndUpdateLineItems(invoiceId, data) {
  try {
    const lineItemXml = await makeJsonToXmlForLineItems(
      invoiceId,
      JSON.parse(JSON.stringify(lineItemPayload)),
      data
    );
    await axios.post(process.env.NETSUIT_AR_API_ENDPOINT, lineItemXml, {
      headers: {
        Accept: "text/xml",
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: "update",
      },
    });
  } catch (error) {
    console.log("error", error);
  }
}

/**
 * prepear the query for update interface_ap_master
 * @param {*} item
 * @param {*} invoiceId
 * @param {*} isSuccess
 * @returns
 */
function getUpdateQuery(item, invoiceId, isSuccess = true) {
  try {
    console.log("invoice_nbr ", item.invoice_nbr, invoiceId);
    let query = `UPDATE interface_ap_master `;
    if (isSuccess) {
      query += ` SET internal_id = '${invoiceId}', processed = 'P', `;
    } else {
      query += ` SET internal_id = null, processed = 'F', `;
    }
    query += ` processed_date = '${today}'  WHERE source_system = '${source_system}' and invoice_nbr = '${item.invoice_nbr}' and invoice_type = '${item.invoice_type}'
              and vendor_id = '${item.vendor_id}' and gc_code = '${item.gc_code}';`;

    return query;
  } catch (error) {
    return "";
  }
}

/**
 * Update processed invoice ids
 * @param {*} connections
 * @param {*} query
 * @returns
 */
async function updateInvoiceId(connections, query) {
  try {
    const result = await connections.query(query);
    return result;
  } catch (error) {
    if (query.length > 0) {
      await sendDevNotification(
        source_system,
        "AP",
        "netsuite_ap_tr updateInvoiceId",
        "Invoice is created But failed to update internal_id " + query,
        error
      );
    }
    throw {
      customError: true,
      msg: "Vendor Bill is created But failed to update internal_id",
      invoiceId,
    };
  }
}

/**
 * hardcode data for the payload.
 * @param {*} source_system
 * @returns
 */
function getHardcodeData(isIntercompany = false) {
  const data = {
    source_system: "1",
    finalizedbyInternalId: process.env.STAGE === "dev" ? "2511" : "2614", //prod:-2614  dev:-2511
    class: {
      head: "9",
      line: getBusinessSegment(process.env.STAGE),
    },
    department: {
      default: { head: "15", line: "2" },
      intercompany: { head: "16", line: "2" },
    },
    location: { head: "18", line: "EXT ID: Take from DB" },
  };
  const departmentType = isIntercompany ? "intercompany" : "default";
  return {
    ...data,
    department: data.department[departmentType],
  };
}

function dateFormat(param) {
  const date = new Date(param);
  return (
    date.getFullYear() +
    "-" +
    ("00" + (date.getMonth() + 1)).slice(-2) +
    "-" +
    ("00" + date.getDate()).slice(-2) +
    "T11:05:03.000Z"
  );
}

function getCustomDate() {
  const date = new Date();
  let ye = new Intl.DateTimeFormat("en", { year: "numeric" }).format(date);
  let mo = new Intl.DateTimeFormat("en", { month: "2-digit" }).format(date);
  let da = new Intl.DateTimeFormat("en", { day: "2-digit" }).format(date);
  return `${ye}-${mo}-${da}`;
}

async function startNextStep() {
  return new Promise((resolve, reject) => {
    try {
      const params = {
        stateMachineArn: process.env.NETSUITE_TR_INTERCOMPANY_STEP_ARN,
        input: JSON.stringify({}),
      };
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.startExecution(params, (err, data) => {
        if (err) {
          console.log(
            "Netsuit NETSUITE_TR_INTERCOMPANY_STEP_ARN trigger failed"
          );
          resolve(false);
        } else {
          console.log("Netsuit NETSUITE_TR_INTERCOMPANY_STEP_ARN started");
          resolve(true);
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}
