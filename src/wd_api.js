const AWS = require("aws-sdk");
const axios = require("axios");
const { convert } = require("xmlbuilder2");
const pgp = require("pg-promise");
const wd_payload = require("../Helpers/wd_payload.json");
const wd_pdf_payload = require("../Helpers/wd_pdf.json");

module.exports.handler = async (event, context, callback) => {
  try {
    /**
     * Get data from db
     */
    const shipmentData = await getDataFromDB();
    console.info("Total shipment data count", shipmentData.length);

    /**
     * Check ETA shipment data process
     */
    for (let i = 0; i < shipmentData.length; i++) {
      let item = shipmentData[i];

      try {
        const newData = await checkStatus(item);
        let itemData = newData.data;
        let is_update = newData.is_update;

        /**
         * Make Json to Xml payload
         */
        const xmlPayload = await makeJsonToXml(
          JSON.parse(JSON.stringify(wd_payload)),
          itemData
        );

        /**
         * Get response from WD api
         */
        const xmlResponse = await getXmlResponse(xmlPayload);

        /**
         * make Xml to Json response
         */
        const refTransmissionNo = makeXmlToJson(xmlResponse);
        console.log("refTransmissionNo", refTransmissionNo);

        /**
         * Update shipment data to dynamo db
         */
        await updateStatus(
          itemData,
          xmlPayload,
          xmlResponse,
          refTransmissionNo,
          is_update
        );
      } catch (error) {
        if (error != "No new data" && error != "No new AH data") {
          console.info("item:", item);
          console.info("error info:", error);
        }
      }
    }

    return "Completed";
  } catch (error) {
    return callback(
      response(
        "[500]",
        error != null && error.hasOwnProperty("message") ? error.message : error
      )
    );
  }
};

async function getDataFromDB() {
  try {
    const dbUser = process.env.USER;
    const dbPassword = process.env.PASS;
    const dbHost = process.env.HOST;
    const dbPort = process.env.PORT;
    const dbName = process.env.DBNAME;

    const dbc = pgp({ capSQL: true });
    const connectionString = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;
    const connections = dbc(connectionString);
    const query = `select distinct
    a.file_nbr ,a.house_bill_nbr ,pod_name,
    a.handling_stn ,a.controlling_stn ,a.chrg_wght_lbs ,a.chrg_wght_kgs ,pieces,
    case b.order_status
    when 'PUP' then 'AF'
    when 'COB' then 'AN'
    when 'DEL'then 'D1'
    when 'OSD' then 'A9'
    when 'REF' then 'A7'
    else order_Status
    end order_Status,
    case b.order_status
    when 'PUP' then 'Pick Up Confirmed'
    when 'COB' then 'Confirmed On Board'
    when 'DEL'then 'Delivered - No Exception'
    when 'REF'then 'Delivery - Refused'
    when 'OSD'then 'Delivered - With Exception'
    else order_Status_desc
    end order_Status_Desc,
    case when b.order_status in ('PUP','COB','DEL','REF','OSD') then b.event_date_utc else null end as Event_Date_utc,
    case when b.order_status in ('PUP','COB') then A.ORIGIN_PORT_IATA
    when b.order_status in ('DEL','REF','OSD') then A.DESTINATION_PORT_IATA
    else '' end as event_city,
    case when b.order_status in ('PUP','COB','DEL') then  'US' else '' end as Event_country,
    coalesce(c.ref_nbr,a.house_bill_nbr)ref_nbr
        from
        shipment_info a
        left outer join shipment_milestone b
        on a.file_nbr = b.file_nbr
        and a.source_system = b.source_system
        left outer join
        (select distinct source_system ,file_nbr ,ref_nbr from shipment_ref where ref_typeid = 'LOA') c
        on a.source_system = c.source_system
        and a.file_nbr = c.file_nbr
        where a.bill_to_nbr = '17833'
        and b.order_status in ('PUP','COB','DEL','POD','OSD','REF')
        and a.file_date >= '2022-03-25'
        union
    select distinct
      a.file_nbr ,a.house_bill_nbr ,pod_name,
      a.handling_stn ,a.controlling_stn ,a.chrg_wght_lbs ,a.chrg_wght_kgs ,pieces,
      'AG' order_Status,
      'ETA for final delivery' order_Status_desc,
      eta_date as Event_Date_utc,
      A.DESTINATION_PORT_IATA as event_city,
      'US' as Event_country,
      coalesce(c.ref_nbr,a.house_bill_nbr ) ref_nbr
          from
          shipment_info a
          left outer join
          (select distinct source_system ,file_nbr ,ref_nbr from shipment_ref where ref_typeid = 'LOA') c
          on a.source_system = c.source_system
          and a.file_nbr = c.file_nbr
          where a.bill_to_nbr = '17833'
          and a.file_date >= '2022-03-25'`;

    const result = await connections.query(query);

    if (result && Array.isArray(result) && result.length > 0) {
      return result;
    }
    throw "No data found.";
  } catch (error) {
    throw "No data found.";
  }
}

async function checkStatus(data) {
  try {
    const documentClient = new AWS.DynamoDB.DocumentClient({
      region: process.env.REGION,
    });

    /**
     * check status
     */
    const params = {
      TableName: process.env.WD_SHIPMENT_STATUS_TABLE,
      Key: {
        id: data.file_nbr.toString() + data.order_status,
        file_nbr: data.file_nbr.toString(),
      },
    };

    const res = await documentClient.get(params).promise();
    //check data exists.
    if (res && res.Item) {
      /**
       * if order_status is other than AG/AH then skip
       */
      if (data.order_status != "AG" && data.order_status != "AH") {
        throw "No new data";
      }
      /**
       * check if event_date_utc not same
       */
      if (
        res.Item.event_date_utc !=
        new Date(data.event_date_utc).toLocaleString()
      ) {
        /**
         * check if AH exists
         */
        const paramsAh = {
          TableName: process.env.WD_SHIPMENT_STATUS_TABLE,
          Key: {
            id: data.file_nbr.toString() + "AH",
            file_nbr: "AH",
          },
        };
        const resAh = await documentClient.get(paramsAh).promise();
        //if AH exists
        if (resAh && resAh.Item) {
          //check if AH event date not same
          if (
            resAh.Item.event_date_utc !=
            new Date(data.event_date_utc).toLocaleString()
          ) {
            //update AH
            return { data: { ...data, order_status: "AH" }, is_update: true };
          } else {
            throw "No new AH data";
          }
        } else {
          //Insert AH
          return { data: { ...data, order_status: "AH" }, is_update: false };
        }
      } else {
        throw "No new data";
      }
    } else {
      return { data, is_update: false };
    }
  } catch (e) {
    throw e;
  }
}

async function makeJsonToXml(payload, inputData) {
  try {
    /**
     * set auth details
     */
    payload["soapenv:Envelope"]["soapenv:Header"]["wsse:Security"][
      "wsse:UsernameToken"
    ]["wsse:Username"] = process.env.WD_API_USERNAME;
    payload["soapenv:Envelope"]["soapenv:Header"]["wsse:Security"][
      "wsse:UsernameToken"
    ]["wsse:Password"]["#"] = process.env.WD_API_PASSWORD;

    /**
     * TransmissionHeader
     */
    let transHeader =
      payload["soapenv:Envelope"]["soapenv:Body"]["tran:publish"][
        "otm:Transmission"
      ]["otm:TransmissionHeader"];
    /**
     * TransmissionBody values
     */

    let transBodyWithValues = null;

    // PUP => BOL
    // POD => POD

    if (inputData.order_status != "PUP" && inputData.order_status != "POD") {
      /**
       * without pdf
       */
      let transBody =
        payload["soapenv:Envelope"]["soapenv:Body"]["tran:publish"][
          "otm:Transmission"
        ]["otm:TransmissionBody"]["otm:GLogXMLElement"]["otm:ShipmentStatus"];
      transBody["otm:IntSavedQuery"]["otm:IntSavedQueryArg"][0][
        "otm:ArgValue"
      ] = validateRefNbr(inputData.ref_nbr)
        ? inputData.ref_nbr
        : inputData.house_bill_nbr;

      transBody["otm:IntSavedQuery"]["otm:IntSavedQueryArg"][1][
        "otm:ArgValue"
      ] = inputData.house_bill_nbr;

      transBody["otm:ShipmentRefnum"][0]["otm:ShipmentRefnumValue"] =
        inputData.ref_nbr; //"2nd H"
      transBody["otm:ShipmentRefnum"][1]["otm:ShipmentRefnumValue"] =
        inputData.chrg_wght_kgs;

      transBody["otm:ShipmentRefnum"][2]["otm:ShipmentRefnumValue"] =
        inputData.pieces;

      if (inputData?.pod_name && inputData.pod_name.length > 0) {
        transBody["otm:ShipmentRefnum"].push({
          "otm:ShipmentRefnumQualifierGid": {
            "otm:Gid": {
              "otm:DomainName": "WDC",
              "otm:Xid": "POD_NAME",
            },
          },
          "otm:ShipmentRefnumValue": inputData.pod_name,
        });
      }

      transBody["otm:WeightVolume"]["otm:Weight"]["otm:WeightValue"] =
        inputData.chrg_wght_kgs;

      transBody["otm:StatusCodeGid"]["otm:Gid"]["otm:Xid"] =
        "W" + inputData.order_status;

      transBody["otm:EventDt"]["otm:GLogDate"] = formatDate(
        inputData.event_date_utc
      );

      transBody["otm:SSStop"]["otm:SSLocation"]["otm:EventCity"] =
        inputData.event_city;
      transBody["otm:SSStop"]["otm:SSLocation"]["otm:EventCountry"] =
        inputData.event_country;

      transBody["otm:TrackingNumber"] = inputData.ref_nbr;

      transBodyWithValues = { "otm:ShipmentStatus": null };
      transBodyWithValues["otm:ShipmentStatus"] = transBody;
    } else {
      /**
       * with pdf
       */
      let wd_pdf = JSON.parse(JSON.stringify(wd_pdf_payload));
      wd_pdf["otm:Document"]["otm:DocumentDefinitionGid"]["otm:Gid"][
        "otm:Xid"
      ] =
        inputData.order_status == "POD"
          ? "PROOF_OF_DELIVERY"
          : "BILL_OF_LADING";

      wd_pdf["otm:Document"]["otm:DocumentOwner"]["otm:ObjectGid"]["otm:Gid"][
        "otm:Xid"
      ] = inputData.ref_nbr;

      /**
       * get base64 pdf
       */
      const base64Pdf = await getBase64Pdf(
        inputData.file_nbr,
        inputData.order_status
      );
      wd_pdf["otm:Document"]["otm:DocumentContent"]["otm:DocContentBinary"] =
        base64Pdf;

      transBodyWithValues = wd_pdf;
    }

    /**
     * set the header and body data
     */
    payload["soapenv:Envelope"]["soapenv:Body"]["tran:publish"][
      "otm:Transmission"
    ]["otm:TransmissionHeader"] = transHeader;

    payload["soapenv:Envelope"]["soapenv:Body"]["tran:publish"][
      "otm:Transmission"
    ]["otm:TransmissionBody"]["otm:GLogXMLElement"] = transBodyWithValues;
    return convert(payload);
  } catch (error) {
    throw error;
  }
}

async function getXmlResponse(postData) {
  try {
    const res = await axios.post(process.env.WD_API, postData, {
      headers: {
        Accept: "text/xml",
        "Content-Type": "text/xml; charset=utf-8",
      },
    });
    return {
      xml_response: res.data,
      status_code: res.status,
      status: res.status == 200 ? "success" : "failed",
    };
  } catch (e) {}
}

function makeXmlToJson(xmlResponse) {
  try {
    const obj = convert(xmlResponse.xml_response, { format: "object" });
    return obj["S:Envelope"]["S:Body"]["publishResponse"][
      "otm:TransmissionAck"
    ]["otm:EchoedTransmissionHeader"]["otm:TransmissionHeader"][
      "otm:ReferenceTransmissionNo"
    ];
  } catch (error) {
    return null;
  }
}

async function updateStatus(
  record,
  xmlPayload,
  xmlResponse,
  refTransmissionNo,
  is_update = false
) {
  let documentClient = new AWS.DynamoDB.DocumentClient({
    region: process.env.DEFAULT_AWS,
  });
  const orderStatusCheck =
    record.order_status != "PUP" && record.order_status != "POD";
  const data = {
    ...record,
    id: record.file_nbr.toString() + record.order_status,
    ReferenceTransmissionNo: refTransmissionNo,
    xml_payload: orderStatusCheck ? xmlPayload : null,
    xml_response: orderStatusCheck ? xmlResponse.xml_response : null,
    status_code: xmlResponse.status_code,
    status:
      refTransmissionNo == -1 || refTransmissionNo == null
        ? "failed"
        : xmlResponse.status,
    event_date_utc: new Date(record.event_date_utc).toLocaleString(),
    created_at: new Date().toLocaleString(),
  };

  try {
    if (is_update) {
      const paramsDT = {
        TableName: process.env.WD_SHIPMENT_STATUS_TABLE,
        Key: {
          id: data.file_nbr.toString() + data.order_status,
          file_nbr: data.file_nbr.toString(),
        },
      };
      await documentClient.delete(paramsDT).promise();
    }

    const params = {
      TableName: process.env.WD_SHIPMENT_STATUS_TABLE,
      Item: data,
    };
    await documentClient.put(params).promise();
  } catch (e) {}
}

async function getBase64Pdf(file_nbr, type) {
  try {
    const pdfApi =
      type == "POD"
        ? process.env.WD_PDF_POD_API_URL
        : process.env.WD_PDF_BOL_API_URL;

    const res = await axios.get(
      `${pdfApi}/${process.env.WD_PDF_API_KEY}/${file_nbr}`
    );
    if (res?.data?.hawb?.b64str) {
      //BOL
      return res.data.hawb.b64str;
    } else if (res?.data?.hcpod?.b64str) {
      //POD
      return res.data.hcpod.b64str;
    } else {
      throw "No Pdf";
    }
  } catch (e) {
    throw "No Pdf";
  }
}

function formatDate(dateObj) {
  var date = new Date(dateObj);
  return (
    date.getFullYear() +
    ("00" + (date.getMonth() + 1)).slice(-2) +
    ("00" + date.getDate()).slice(-2) +
    ("00" + date.getHours()).slice(-2) +
    ("00" + date.getMinutes()).slice(-2) +
    ("00" + date.getSeconds()).slice(-2)
  );
}

function validateRefNbr(ref_nbr = null) {
  try {
    const split =
      ref_nbr != null
        ? ref_nbr.split("-")
        : (() => {
            throw "error null";
          })();
    const dateStr = parseInt(split[0]);
    const isdate =
      split.length == 2
        ? new Date(dateStr) !== "Invalid Date" && !isNaN(new Date(dateStr))
        : false;
    if (isdate && split[1].length > 4) {
      return true;
    } else {
      throw "error1";
    }
  } catch (error) {
    return false;
  }
}

function response(code, message) {
  return JSON.stringify({
    httpStatus: code,
    message,
  });
}
