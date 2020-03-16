const fs = require('fs-extra');
const path = require('path');
const winston = require('winston');
const request = require('request');
const config = require('../../config');

const apiPath = config.dir.instanceDefinitions.oracleApi;
const responsesPath = path.join(apiPath, 'responses');
const definitionsPath = path.join(apiPath, 'definitions');
const webMIMETypes = fs.readJsonSync(path.join(__dirname, '..', 'static', 'webMIMETypes.json'));

const schemaPath = path.join(apiPath, 'schema.json');

class ApiSchema {
  constructor(options, instance) {
    this.options = options;
    this.instanceOptions = instance.options;

    this.schemaURL = `${config.endpoints.dns}/ccstore/v1/metadata-catalog`;
    this.registryEndpoint = `${config.endpoints.dns}/ccstoreui/v1/registry`;
  }

  makeRequest(url) {
    winston.info(`Requesting ${url}...`);

    const requestConfigs = {
      url : url
    };

    return new Promise((resolve, reject) => {
      request(requestConfigs, (error, response, body) => {
        if(error) {
          return reject(error);
        }

        try {
          const parsedBody = JSON.parse(body);
          if(parsedBody.status === '404') {
            return reject(parsedBody);
          }
        } catch(error) {
          return reject(error);
        }

        resolve({ response: response, body: body });
      });
    });
  }

  grab() {
    return new Promise(async (resolve, reject) => {
      winston.info(`Requesting schema from ${this.schemaURL}...`);

      try {
        const schemaRequestResponse = await this.makeRequest(this.schemaURL);
        const registryRequestResponse = await this.makeRequest(this.registryEndpoint);

        const schemaJSON = JSON.parse(schemaRequestResponse.body);
        const registryJSON = JSON.parse(registryRequestResponse.body);
        const endpointMap = registryJSON.endpointMap;
        const schemaPaths = schemaJSON.paths;

        winston.info('Updating schema...');

        if(!/ui/.test(schemaJSON.basePath)) {
          schemaJSON.basePath = schemaJSON.basePath.replace('ccadmin', 'ccadminui').replace('ccstore', 'ccstoreui');
        }

        const operationsIds = [];

        for(const requestPathKey of Object.keys(schemaPaths)) {
          for(const method of Object.keys(schemaPaths[requestPathKey])) {
            operationsIds.push(schemaPaths[requestPathKey][method].operationId);
          }
        }

        // Setting missing endpoints(Not available in the metadata-catalog)
        for(const endpointMapKey of Object.keys(endpointMap)) {
          const endpointMapData = endpointMap[endpointMapKey];

          if(!operationsIds.includes(endpointMapKey)) {
            const method = endpointMapData.method.toLowerCase();
            let sampleResponse = {};
            let endpointMapResponse;

            try {
              if(method === 'get' && !/\{\}/.test(endpointMapData.url)) {
                endpointMapResponse = await this.makeRequest(`${config.endpoints.dns}${endpointMapData.url}`);
                sampleResponse = JSON.parse(endpointMapResponse.body);
              }
            } catch(error) {}

            schemaPaths[endpointMapData.url.replace('/ccstoreui/v1', '')] = {
              [method]: {
                summary: endpointMapData.id,
                operationId: endpointMapData.id,
                produces: ['application/json'],
                responses: {
                  "200": {
                    "examples": {
                      "application/json": sampleResponse
                    }
                  }
                }
              }
            };
          }
        }

        // Setting paths
        for(const requestPathKey of Object.keys(schemaPaths)) {
          const requestPath = schemaPaths[requestPathKey];

          for(const method of Object.keys(requestPath)) {
            const requestData = requestPath[method];
            const responses = requestData.responses;
            const requestId = requestData.operationId;
            const responseMethodPath = path.join(responsesPath, `${requestId}`);

            fs.ensureDirSync(responseMethodPath);

            for(const statusCode of Object.keys(responses)) {
              // Don't create structure for the default
              if(statusCode === 'default') {
                continue;
              }

              const responsePath = path.join(responseMethodPath, 'default');
              const dataDescriptorPath = path.join(responsePath, 'descriptor.json');
              const dataPath = path.join(responsePath, 'data.json');

              const descriptor = {
                allowedParameters: requestData.parameters,
                request: {
                  queryParameters: {},
                  method,
                  headers: {},
                  body: {}
                },
                response: {
                  dataPath: path.relative(responsePath, dataPath),
                  statusCode,
                  headers: {}
                }
              };

              await fs.ensureDir(responsePath);

              if(!responses[statusCode].examples) {
                responses[statusCode].examples = {
                  "application/json": { sample: true }
                };
              }

              let contentTypeList = Object.keys(responses[statusCode].examples);
              const foundValidMIMEType = contentTypeList.some(mimeType => webMIMETypes.includes(mimeType));

              // If didn't find any valid mime type, consider it as application/json
              if(!foundValidMIMEType) {
                contentTypeList = ['application/json'];
              }

              let contentType = contentTypeList[0];
              let responseData = responses[statusCode].examples[contentType];

              if(responseData) {
                if(requestId === 'getRegistry') {
                  responseData = registryJSON;
                }

                descriptor.response.headers['content-type'] = contentType;
                let stringifiedResponseData = JSON.stringify(responseData, null, 2);

                if(stringifiedResponseData) {
                  stringifiedResponseData = stringifiedResponseData.replace(/https?:\/\/localhost:[0-9]+?\//g, config.endpoints.local);
                }

                await fs.outputJSON(dataPath, JSON.parse(stringifiedResponseData), { spaces: 2 });
              }

              await fs.outputJSON(dataDescriptorPath, descriptor, { spaces: 2 });
            }

            requestData.responses = path.relative(apiPath, responseMethodPath);
          }
        }

        // Setting Definitions
        for(const schemaDefinitionPath of Object.keys(schemaJSON.definitions)) {
          const definitionPath = path.join(definitionsPath, `${schemaDefinitionPath}.json`);
          await fs.outputJSON(definitionPath, schemaJSON.definitions[schemaDefinitionPath], { spaces: 2 });
        }
        delete schemaJSON.definitions;

        await fs.outputJSON(schemaPath, schemaJSON, { spaces: 2 });
        winston.info('Schema Updated!');
        resolve();
      } catch(error) {
        reject(error);
      }
    });
  }
}

module.exports = async function(action, options, callback) {
  const apiSchema = new ApiSchema(options, this);

  try {
    switch(action) {
      case 'grab':
        callback(null, await apiSchema.grab());
        break;
      default:
        callback();
    }
  } catch(errorResponse) {
    winston.error(errorResponse);
    callback(errorResponse);
  }
};