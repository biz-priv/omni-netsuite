const AWS = require("aws-sdk");
const axios = require("axios");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");


const userConfig = {
    account: "1238234",
    apiVersion: "2021_2",
    realm: process.env.NETSUIT_AR_ACCOUNT,
    signature_method: "HMAC-SHA256",
    token: {
      consumer_key: "dc5a854e86c5bd48417c26ec1287cb5577f19d147acb48415e95ceb475ce04a5",
      consumer_secret: "4c53c17215ace3a0d0cb2530685c3609488ab7b8a2e3c3c0fe499779bd6c108a",
      token_key: "57c7ad8e5b88cdf0f4614066cc17822c3e57b5cfa596e54b6bbfa2dc2f7c4c4b",
      token_secret: "35b585473e5352b8120c7da0865fc6e4c3315a91e96458296fb091c35f2d4d81",
    },
  };

  async function createInterCompanyInvoice() {
    const apInvoiceId = "11837766";
    const arInvoiceId = "11287033";
    const invoice_type= "CM"
    const transactionType = invoice_type == "IN" ? "invoice" : "creditmemo";
    try {
      const baseUrl = process.env.NETSUITE_INTERCOMPANY_BASE_URL;
      const url = `https://1238234.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=679&deploy=1&iid1=13597521&iid2=13598173&transactionType=invoice`;
      const authHeader = getAuthorizationHeader(url);
      const headers = {
        ...authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      const res = await axios.get(url, { headers });
      if (res.data == "success") {
        return true;
      } else {
        console.log("HI",res.data);
        throw {
          data: res.data,
        };
      }
    } catch (error) {
        console.log("error",error,arInvoiceId,apInvoiceId,transactionType,error?.data, error?.response?.data);
      throw {
        customError: true,
        arInvoiceId,
        apInvoiceId,
        transactionType,
        data: error?.data ?? error?.response?.data,
      };
    }
  }
  
  function getAuthorizationHeader(url) {
    try {
      const oauth = OAuth({
        consumer: {
          key: userConfig.token.consumer_key,
          secret: userConfig.token.consumer_secret,
        },
        realm: userConfig.realm,
        signature_method: userConfig.signature_method,
        hash_function: (base_string, key) =>
          crypto.createHmac("sha256", key).update(base_string).digest("base64"),
      });
      return oauth.toHeader(
        oauth.authorize(
          {
            url: url,
            method: "get",
          },
          {
            key: userConfig.token.token_key,
            secret: userConfig.token.token_secret,
          }
        )
      );
    } catch (error) {
      throw error;
    }
  }


  createInterCompanyInvoice()