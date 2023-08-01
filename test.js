// // const AWS = require("aws-sdk");
// // const axios = require("axios");
// // const crypto = require("crypto");
// // const OAuth = require("oauth-1.0a");


// // const userConfig = {
// //     account: "1238234",
// //     apiVersion: "2021_2",
// //     realm: process.env.NETSUIT_AR_ACCOUNT,
// //     signature_method: "HMAC-SHA256",
// //     token: {
// //       consumer_key: "dc5a854e86c5bd48417c26ec1287cb5577f19d147acb48415e95ceb475ce04a5",
// //       consumer_secret: "4c53c17215ace3a0d0cb2530685c3609488ab7b8a2e3c3c0fe499779bd6c108a",
// //       token_key: "57c7ad8e5b88cdf0f4614066cc17822c3e57b5cfa596e54b6bbfa2dc2f7c4c4b",
// //       token_secret: "35b585473e5352b8120c7da0865fc6e4c3315a91e96458296fb091c35f2d4d81",
// //     },
// //   };

// //   async function createInterCompanyInvoice() {
// //     const apInvoiceId = "11837766";
// //     const arInvoiceId = "11287033";
// //     const invoice_type= "CM"
// //     const transactionType = invoice_type == "IN" ? "invoice" : "creditmemo";
// //     try {
// //       const baseUrl = process.env.NETSUITE_INTERCOMPANY_BASE_URL;
// //       const url = `https://1238234.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=679&deploy=1&iid1=13597521&iid2=13598173&transactionType=invoice`;
// //       const authHeader = getAuthorizationHeader(url);
// //       const headers = {
// //         ...authHeader,
// //         Accept: "application/json",
// //         "Content-Type": "application/json",
// //       };
// //       const res = await axios.get(url, { headers });
// //       if (res.data == "success") {
// //         return true;
// //       } else {
// //         console.log("HI",res.data);
// //         throw {
// //           data: res.data,
// //         };
// //       }
// //     } catch (error) {
// //         console.log("error",error,arInvoiceId,apInvoiceId,transactionType,error?.data, error?.response?.data);
// //       throw {
// //         customError: true,
// //         arInvoiceId,
// //         apInvoiceId,
// //         transactionType,
// //         data: error?.data ?? error?.response?.data,
// //       };
// //     }
// //   }
  
// //   function getAuthorizationHeader(url) {
// //     try {
// //       const oauth = OAuth({
// //         consumer: {
// //           key: userConfig.token.consumer_key,
// //           secret: userConfig.token.consumer_secret,
// //         },
// //         realm: userConfig.realm,
// //         signature_method: userConfig.signature_method,
// //         hash_function: (base_string, key) =>
// //           crypto.createHmac("sha256", key).update(base_string).digest("base64"),
// //       });
// //       return oauth.toHeader(
// //         oauth.authorize(
// //           {
// //             url: url,
// //             method: "get",
// //           },
// //           {
// //             key: userConfig.token.token_key,
// //             secret: userConfig.token.token_secret,
// //           }
// //         )
// //       );
// //     } catch (error) {
// //       throw error;
// //     }
// //   }


// //   createInterCompanyInvoice()

// const moment = require('moment');
// const newdate= {
//   internal_id: '13482184',
//   type: 'Bill',
//   date_created: moment('07/01/2023 1:36 pm').format('YYYY-MM-DD HH:mm:ss'),
//   transaction_no: 'DECREBATE2021',
//   amount: '-1775444.35',
//   company_name: 'COMCAST CORPORATION',
//   shipment: '4069615',
//   due_date: moment('01/30/2022').format('YYYY-MM-DD'),
//   source_system: 'WT',
//   paying_transaction: 'Bill Credit #COMCASTREBATE2021CM',
//   amount_remaining: '.00',
//   load_create_date: '2023-07-27 14:48:29',
//   load_update_date: '2023-07-27 14:48:29'
// }
// console.log(newdate);
// // function convertToDate(dateString) {
// //   const timestamp = Date.parse(dateString);
// //   const date = new Date(timestamp);
// //   const year = date.getFullYear();
// //   const month = String(date.getMonth() + 1).padStart(2, '0');
// //   const day = String(date.getDate()).padStart(2, '0');
// //   return `${year}-${month}-${day}`;
// // }


// // function convertToTimestamp(dateString) {
// //   const timestamp = moment(dateString).format('YYYY-MM-DD HH:mm:ss');
// //   return timestamp;
// // }




// customer-ar-wt

// async function putCustomer(connections, customerData, customer_id) {
//   try {
//     const customer_internal_id = customerData.internalid;

//     const formatData = {
//       customer_internal_id: customerData?.internalid ?? "",
//       customer_id: customerData?.entityid ?? "",
//       // currency_internal_id: customerData?.currency.id,
//       // curr_cd: customerData?.currency.refName,
//       // currency_id: customerData?.currency.id,
//       // currency_refName: customerData?.currency.refName,
//       // externalId: customerData?.externalId ?? "",
//       // custentity5: customerData?.custentity5 ?? "",
//       // custentity_2663_customer_refund:
//       //   customerData?.custentity_2663_customer_refund ?? "",
//       // custentity_2663_direct_debit:
//       //   customerData?.custentity_2663_direct_debit ?? "",
//       // custentity_ee_account_no: customerData?.custentity_ee_account_no ?? "",
//       // custentity_riv_assigned_collector:
//       //   customerData?.custentity_riv_assigned_collector ?? "",
//       // dateCreated: customerData?.dateCreated ?? "",
//       // daysOverdue: customerData?.daysOverdue ?? "",
//       // defaultAddress:
//       //   customerData?.defaultAddress.length > 0
//       //     ? customerData?.defaultAddress.replace(/'/g, "`")
//       //     : "",
//       // depositBalance: customerData?.depositBalance ?? "",
//       // autoName: customerData?.autoName ?? "",
//       // balance: customerData?.balance ?? "",
//       // companyName:
//       //   customerData?.companyName.length > 0
//       //     ? customerData?.companyName.replace(/'/g, "`")
//       //     : "",
//       // emailTransactions: customerData?.emailTransactions ?? "",
//       // faxTransactions: customerData?.faxTransactions ?? "",
//       // isAutogeneratedRepresentingEntity:
//       //   customerData?.isAutogeneratedRepresentingEntity ?? "",
//       // isInactive: customerData?.isInactive ?? "",
//       // isPerson: customerData?.isPerson ?? "",
//       // lastModifiedDate: customerData?.lastModifiedDate ?? "",
//       // overdueBalance: customerData?.overdueBalance ?? "",
//       // printTransactions: customerData?.printTransactions ?? "",
//       // unbilledOrders: customerData?.unbilledOrders ?? "",
//       // shipComplete: customerData?.shipComplete ?? "",

//       // alcoholRecipientType_id: customerData?.alcoholRecipientType.id,
//       // alcoholRecipientType_refName: customerData?.alcoholRecipientType.refName,
//       // creditHoldOverride_id: customerData?.creditHoldOverride.id,
//       // creditHoldOverride_refName: customerData?.creditHoldOverride.refName,
//       // customForm_id: customerData?.customForm.id,
//       // customForm_refName: customerData?.customForm.refName,
//       // emailPreference_id: customerData?.emailPreference.id,
//       // emailPreference_refName: customerData?.emailPreference.refName,
//       // entityStatus_id: customerData?.entityStatus.id,
//       // entityStatus_refName: customerData?.entityStatus.refName,
//       // receivablesAccount_id: customerData?.receivablesAccount.id,
//       // receivablesAccount_refName: customerData?.receivablesAccount.refName,
//       // shippingCarrier_id: customerData?.shippingCarrier.id,
//       // shippingCarrier_refName: customerData?.shippingCarrier.refName,
//       // subsidiary_id: customerData?.subsidiary.id,
//       // subsidiary_refName: customerData?.subsidiary.refName,
//       // terms_id: customerData?.terms.id,
//       // terms_refName: customerData?.terms.refName,
//       // created_at: moment().format("YYYY-MM-DD"),
//     };

//     let tableStr = "";
//     let valueStr = "";
//     let updateStr = "";

//     let objKyes = Object.keys(formatData);
//     objKyes.map((e, i) => {
//       if (i > 0) {
//         valueStr += ",";
//         updateStr += e != "customer_id" ? "," : "";
//       }
//       if (e != "customer_id") {
//         updateStr += e + "='" + formatData[e] + "'";
//       }
//       valueStr += "'" + formatData[e] + "'";
//     });
//     tableStr = objKyes.join(",");


//     const upsertQuery = `INSERT INTO ${arDbNamePrev}netsuit_customer (${tableStr})
//                         VALUES (${valueStr}) ON DUPLICATE KEY
//                         UPDATE ${updateStr};`;
//     console.info("query", upsertQuery);
//     await connections.execute(upsertQuery);

//     const updateQuery = `UPDATE ${arDbName} SET 
//                     processed = null, 
//                     customer_internal_id = '${customer_internal_id}', 
//                     processed_date = '${today}' 
//                     WHERE customer_id = '${customer_id}' and source_system = '${source_system}' and customer_internal_id is null`;
//     console.info("updateQuery", updateQuery);
//     await connections.execute(updateQuery);
//   } catch (error) {
//     console.error(error);
//     throw "Customer Update Failed";
//   }
// }


// vendor-ap-wt
// async function putVendor(connections, vendorData, vendor_id) {
//   try {
//     const vendor_internal_id = vendorData.internalid;

//     const formatData = {
//       vendor_internal_id: vendorData?.internalid ?? "",
//       vendor_id: vendorData?.entityid ?? "",
//       externalId: vendorData?.externalId,
//       balance: vendorData?.balance,
//       balancePrimary: vendorData?.balancePrimary,
//       companyName: vendorData?.companyName,
//       currency_internal_id: vendorData?.currency.id,
//       curr_cd: vendorData?.currency.refName,
//       currency_id: vendorData?.currency.id,
//       currency_refName: vendorData?.currency.refName,
//       custentity_1099_misc: vendorData?.custentity_1099_misc,
//       custentity_11724_pay_bank_fees:
//         vendorData?.custentity_11724_pay_bank_fees,
//       custentity_2663_payment_method:
//         vendorData?.custentity_2663_payment_method,
//       custentity_riv_external_id: vendorData?.custentity_riv_external_id,
//       dateCreated: vendorData?.dateCreated,
//       defaultAddress: vendorData?.defaultAddress,
//       emailTransactions: vendorData?.emailTransactions,
//       faxTransactions: vendorData?.faxTransactions,
//       isAutogeneratedRepresentingEntity:
//         vendorData?.isAutogeneratedRepresentingEntity,
//       isInactive: vendorData?.isInactive,
//       isJobResourceVend: vendorData?.isJobResourceVend,
//       isPerson: vendorData?.isPerson,
//       lastModifiedDate: vendorData?.lastModifiedDate,
//       legalName: vendorData?.legalName,
//       phone: vendorData?.phone,
//       printTransactions: vendorData?.printTransactions,
//       subsidiaryEdition: vendorData?.subsidiaryEdition,
//       unbilledOrders: vendorData?.unbilledOrders,
//       unbilledOrdersPrimary: vendorData?.unbilledOrdersPrimary,

//       customForm_id: vendorData?.customForm.id,
//       customForm_refName: vendorData?.customForm.refName,
//       emailPreference_id: vendorData?.emailPreference.id,
//       emailPreference_refName: vendorData?.emailPreference.refName,
//       subsidiary_id: vendorData?.subsidiary.id,
//       subsidiary_refName: vendorData?.subsidiary.refName,

//       // created_at: moment().format("YYYY-MM-DD"),
//     };

//     let tableStr = "";
//     let valueStr = "";
//     let updateStr = "";

//     let objKyes = Object.keys(formatData);
//     objKyes.map((e, i) => {
//       if (i > 0) {
//         valueStr += ",";
//         updateStr += e != "vendor_id" ? "," : "";
//       }
//       if (e != "vendor_id") {
//         updateStr += e + "='" + formatData[e] + "'";
//       }
//       valueStr += "'" + formatData[e] + "'";
//     });
//     tableStr = objKyes.join(",");

//     const upsertQuery = `INSERT INTO ${apDbNamePrev}netsuit_vendors (${tableStr})
//                         VALUES (${valueStr}) ON DUPLICATE KEY
//                         UPDATE ${updateStr};`;
//     console.info("upsertQuery", upsertQuery);
//     // await connections.execute(upsertQuery);

//     const updateQuery = `UPDATE  ${apDbName} SET
//                     processed = null,
//                     vendor_internal_id = '${vendor_internal_id}', 
//                     processed_date = '${today}' 
//                     WHERE vendor_id = '${vendor_id}' and source_system = '${source_system}' and vendor_internal_id is null;`;
//     console.info("updateQuery", updateQuery);
//     await connections.execute(updateQuery);
//   } catch (error) {
//     console.error(error);
//     throw "Vendor Update Failed";
//   }
// }

// ar-mcl

// async function putCustomer(connections, customerData, customer_id) {
//   try {
//     const customer_internal_id = customerData.internalid;

//     const formatData = {
//       customer_internal_id: customerData?.internalid ?? "",
//       customer_id: customerData?.entityId ?? "",
//       currency_internal_id: customerData?.currency.id,
//       curr_cd: customerData?.currency.refName,
//       currency_id: customerData?.currency.id,
//       currency_refName: customerData?.currency.refName,
//       externalId: customerData?.externalId ?? "",
//       custentity5: customerData?.custentity5 ?? "",
//       custentity_2663_customer_refund:
//         customerData?.custentity_2663_customer_refund ?? "",
//       custentity_2663_direct_debit:
//         customerData?.custentity_2663_direct_debit ?? "",
//       custentity_ee_account_no: customerData?.custentity_ee_account_no ?? "",
//       custentity_riv_assigned_collector:
//         customerData?.custentity_riv_assigned_collector ?? "",
//       dateCreated: customerData?.dateCreated ?? "",
//       daysOverdue: customerData?.daysOverdue ?? "",
//       defaultAddress: customerData?.defaultAddress ?? "",
//       depositBalance: customerData?.depositBalance ?? "",
//       autoName: customerData?.autoName ?? "",
//       balance: customerData?.balance ?? "",
//       companyName: customerData?.companyName ?? "",
//       emailTransactions: customerData?.emailTransactions ?? "",
//       faxTransactions: customerData?.faxTransactions ?? "",
//       isAutogeneratedRepresentingEntity:
//         customerData?.isAutogeneratedRepresentingEntity ?? "",
//       isInactive: customerData?.isInactive ?? "",
//       isPerson: customerData?.isPerson ?? "",
//       lastModifiedDate: customerData?.lastModifiedDate ?? "",
//       overdueBalance: customerData?.overdueBalance ?? "",
//       printTransactions: customerData?.printTransactions ?? "",
//       unbilledOrders: customerData?.unbilledOrders ?? "",
//       shipComplete: customerData?.shipComplete ?? "",

//       alcoholRecipientType_id: customerData?.alcoholRecipientType.id,
//       alcoholRecipientType_refName: customerData?.alcoholRecipientType.refName,
//       creditHoldOverride_id: customerData?.creditHoldOverride.id,
//       creditHoldOverride_refName: customerData?.creditHoldOverride.refName,
//       customForm_id: customerData?.customForm.id,
//       customForm_refName: customerData?.customForm.refName,
//       emailPreference_id: customerData?.emailPreference.id,
//       emailPreference_refName: customerData?.emailPreference.refName,
//       entityStatus_id: customerData?.entityStatus.id,
//       entityStatus_refName: customerData?.entityStatus.refName,
//       receivablesAccount_id: customerData?.receivablesAccount.id,
//       receivablesAccount_refName: customerData?.receivablesAccount.refName,
//       shippingCarrier_id: customerData?.shippingCarrier.id,
//       shippingCarrier_refName: customerData?.shippingCarrier.refName,
//       subsidiary_id: customerData?.subsidiary.id,
//       subsidiary_refName: customerData?.subsidiary.refName,
//       terms_id: customerData?.terms.id,
//       terms_refName: customerData?.terms.refName,
//       // created_at: moment().format("YYYY-MM-DD"),
//     };

//     let tableStr = "";
//     let valueStr = "";
//     let updateStr = "";

//     let objKyes = Object.keys(formatData);
//     objKyes.map((e, i) => {
//       if (i > 0) {
//         valueStr += ",";
//         updateStr += e != "customer_id" ? "," : "";
//       }
//       if (e != "customer_id") {
//         updateStr += e + "='" + formatData[e] + "'";
//       }
//       valueStr += "'" + formatData[e] + "'";
//     });
//     tableStr = objKyes.join(",");


//     const upsertQuery = `INSERT INTO ${arDbNamePrev}netsuit_customer (${tableStr})
//                         VALUES (${valueStr}) ON DUPLICATE KEY
//                         UPDATE ${updateStr};`;
//     await connections.execute(upsertQuery);

//     const updateQuery = `UPDATE ${arDbName} SET 
//                     processed = null, 
//                     customer_internal_id = '${customer_internal_id}', 
//                     processed_date = '${today}' 
//                     WHERE customer_id = '${customer_id}' and source_system = '${source_system}' and customer_internal_id is null`;
//     console.info("updateQuery", updateQuery);
//     await connections.execute(updateQuery);
//   } catch (error) {
//     console.error(error);
//     throw "Customer Update Failed";
//   }
// }

// get customer rest api 
// // function getcustomer(entityId) {
// //   return new Promise((resolve, reject) => {
// // const NsApi = new NsApiWrapper({
// //   consumer_key: userConfig.token.consumer_key,
// //   consumer_secret_key: userConfig.token.consumer_secret,
// //   token: userConfig.token.token_key,
// //   token_secret: userConfig.token.token_secret,
// //   realm: userConfig.account,
// //     });
// //     NsApi.request({
// //       path: `record/v1/customer/eid:${entityId}`,
// //     })
// //       .then((response) => {
// //         const recordList = response.data;
// //         if (recordList && recordList.id) {
// //           const record = recordList;
// //           resolve(record);
// //         } else {
// //           reject({
// //             customError: true,
// //             msg: `Customer not found. (customer_id: ${entityId})`,
// //           });
// //         }
// //       })
// //       .catch((err) => {
// //         console.error("error", err);
// //         reject({
// //           customError: true,
// //           msg: `Customer not found. (customer_id: ${entityId})`,
// //         });
// //       });
// //   });
// // }



// vendor ap

// // function getVendor(entityId) {
// //   return new Promise((resolve, reject) => {
// //     const NsApi = new NsApiWrapper({
// //       consumer_key: userConfig.token.consumer_key,
// //       consumer_secret_key: userConfig.token.consumer_secret,
// //       token: userConfig.token.token_key,
// //       token_secret: userConfig.token.token_secret,
// //       realm: userConfig.account,
// //     });
// //     NsApi.request({
// //       path: `record/v1/vendor/eid:${entityId}`,
// //     })
// //       .then((response) => {
// //         const recordList = response.data;
// //         if (recordList && recordList.id) {
// //           const record = recordList;
// //           resolve(record);
// //         } else {
// //           reject({
// //             customError: true,
// //             msg: `Vendor not found. (vendor_id: ${entityId})`,
// //           });
// //         }
// //       })
// //       .catch((err) => {
// //         console.error("err", err);
// //         reject({
// //           customError: true,
// //           msg: `Vendor not found. (vendor_id: ${entityId})`,
// //         });
// //       });
// //   });
// // }