const aws = require("aws-sdk");

exports.handler = (event, context, callback) => {
  const params = {
    stateMachineArn: process.env.NETSUITE_CUSTOMER_STEP_ARN,
    input: JSON.stringify({}),
  };
  const stepfunctions = new aws.StepFunctions();
  stepfunctions.startExecution(params, (err, data) => {
    if (err) {
      const response = {
        statusCode: 500,
        body: JSON.stringify({
          message: "There was an error",
        }),
      };
      callback(null, response);
    } else {
      const response = {
        statusCode: 200,
        body: JSON.stringify({
          message: "Step function worked",
        }),
      };
      callback(null, response);
    }
  });
};
