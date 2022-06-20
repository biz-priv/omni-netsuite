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
  };
  return data[source_system];
}

function getConnection(env, dbc) {
  try {
    const dbUser = env.USER;
    const dbPassword = env.PASS;
    const dbHost = env.HOST;
    // const dbHost = "omni-dw-prod.cnimhrgrtodg.us-east-1.redshift.amazonaws.com";
    const dbPort = env.PORT;
    const dbName = env.DBNAME;

    const connectionString = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;
    return dbc(connectionString);
  } catch (error) {
    throw "DB Connection Error";
  }
}
module.exports = { getConfig, getConnection };
