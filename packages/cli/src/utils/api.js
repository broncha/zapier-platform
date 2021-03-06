const _ = require('lodash');
const colors = require('colors/safe');
const debug = require('debug')('zapier:api');

const constants = require('../constants');

const qs = require('querystring');

const fs = require('fs');
const AdmZip = require('adm-zip');
const fetch = require('node-fetch');
const path = require('path');

const { writeFile, readFile } = require('./files');

const { prettyJSONstringify, startSpinner, endSpinner } = require('./display');

const { localAppCommand } = require('./local');

// TODO split these out into better files

// Reads the JSON file at ~/.zapierrc (AUTH_LOCATION).
const readCredentials = (explodeIfMissing = true) => {
  if (process.env.ZAPIER_DEPLOY_KEY) {
    return Promise.resolve({
      [constants.AUTH_KEY]: process.env.ZAPIER_DEPLOY_KEY
    });
  } else {
    return Promise.resolve(
      readFile(constants.AUTH_LOCATION, 'Please run `zapier login`.')
        .then(buf => {
          return JSON.parse(buf.toString());
        })
        .catch(err => {
          if (explodeIfMissing) {
            throw err;
          } else {
            return {};
          }
        })
    );
  }
};

// Calls the underlying platform REST API with proper authentication.
const callAPI = (
  route,
  options,
  rawError = false,
  credentialsRequired = true
) => {
  // temp manual enable while we're not all the way moved over
  if (_.get(global, ['argOpts', 'debug'])) {
    debug.enabled = true;
  }

  options = options || {};
  const url = options.url || constants.ENDPOINT + route;

  const requestOptions = {
    method: options.method || 'GET',
    url,
    body: options.body ? JSON.stringify(options.body) : null,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': `${constants.PACKAGE_NAME}/${constants.PACKAGE_VERSION}`,
      'X-Requested-With': 'XMLHttpRequest'
    }
  };
  return Promise.resolve(requestOptions)
    .then(_requestOptions => {
      // requestOptions === _requestOptions side step for linting
      if (options.skipDeployKey) {
        return _requestOptions;
      } else {
        return readCredentials(credentialsRequired).then(credentials => {
          _requestOptions.headers['X-Deploy-Key'] =
            credentials[constants.AUTH_KEY];
          return _requestOptions;
        });
      }
    })
    .then(_requestOptions => {
      return fetch(_requestOptions.url, _requestOptions);
    })
    .then(res => {
      return Promise.all([res, res.text()]);
    })
    .then(([res, text]) => {
      let errors;
      const hitError = res.status >= 400;
      if (hitError) {
        try {
          errors = JSON.parse(text).errors.join(', ');
        } catch (err) {
          errors = (text || 'Unknown error').slice(0, 250);
        }
      }

      debug(`>> ${requestOptions.method} ${requestOptions.url}`);
      if (requestOptions.body) {
        const replacementStr = 'raw zip removed in logs';
        const requestBody = JSON.parse(requestOptions.body);
        const cleanedBody = {};
        for (const k in requestBody) {
          if (k.includes('zip_file')) {
            cleanedBody[k] = replacementStr;
          } else {
            cleanedBody[k] = requestBody[k];
          }
        }
        debug(`>> ${JSON.stringify(cleanedBody)}`);
      }
      debug(`<< ${res.status}`);
      debug(`<< ${(text || '').substring(0, 2500)}`);
      debug('------------'); // to help differentiate request from each other

      if (hitError) {
        const niceMessage = `"${requestOptions.url}" returned "${res.status}" saying "${errors}"`;

        if (rawError) {
          res.text = text;
          try {
            res.json = JSON.parse(text);
          } catch (e) {
            res.json = {};
          }
          res.errText = niceMessage;
          return Promise.reject(res);
        } else {
          throw new Error(niceMessage);
        }
      }

      return JSON.parse(text);
    });
};

// Given a valid username and password - create a new deploy key.
const createCredentials = (username, password, totpCode) => {
  return callAPI(
    '/keys',
    {
      skipDeployKey: true,
      method: 'POST',
      body: {
        username,
        password,
        totp_code: totpCode
      }
    },
    // if totp is empty, we want a raw request so we can supress an error. If it's here, we want it to be "non-raw"
    !totpCode
  );
};

/**
 * read local `apprc` file
 */
const getLinkedAppConfig = async (appDir, explodeIfMissing = true) => {
  appDir = appDir || '.';

  const file = path.resolve(appDir, constants.CURRENT_APP_FILE);
  try {
    const buf = await readFile(file);
    return JSON.parse(buf.toString());
  } catch (e) {
    if (explodeIfMissing) {
      throw e;
    }
    return {};
  }
};

/**
 * write local `apprc` file
 */
const writeLinkedAppConfig = async (app, appDir) => {
  const file = appDir
    ? path.resolve(appDir, constants.CURRENT_APP_FILE)
    : constants.CURRENT_APP_FILE;

  // we want to eat errors about bad json and missing files
  // and ensure the below code is passes a js object
  let config;
  try {
    // read contents of existing config before writing
    const configBuff = await readFile(file);

    config = JSON.parse(configBuff.toString());
  } catch (e) {
    config = {};
  }
  const updatedConfig = { ...config, id: app.id, key: app.key };

  return writeFile(file, prettyJSONstringify(updatedConfig));
};

/**
 * gets app details from API
 */
const getLinkedApp = async appDir => {
  try {
    const app = await getLinkedAppConfig(appDir);
    if (!app) {
      return {};
    }
    return callAPI('/apps/' + app.id);
  } catch (e) {
    if (constants.IS_TESTING) {
      console.error(e);
    }
    throw new Error(
      `Unable to complete that operation. Either:
* your auth file is stale (run \`${colors.cyan('zapier login')}\`)
* your ${
        constants.CURRENT_APP_FILE
      } points to an app you can't access (run \`${colors.cyan(
        'zapier link'
      )}\` to refresh the link to an existing app or \`${colors.cyan(
        'zapier register'
      )}\` to create a new app).`
    );
  }
};

// Loads the linked app version from the API
const getVersionInfo = () => {
  return Promise.all([
    getLinkedApp(),
    localAppCommand({ command: 'definition' })
  ]).then(([app, definition]) => {
    return callAPI(`/apps/${app.id}/versions/${definition.version}`);
  });
};

const checkCredentials = () => callAPI('/check');

const listApps = async () => {
  let linkedApp;
  try {
    linkedApp = await getLinkedApp();
  } catch (e) {
    // no worries
  }

  const apps = await callAPI('/apps');

  return {
    app: linkedApp,
    apps: apps.objects.map(app => {
      app.linked =
        linkedApp && app.id === linkedApp.id ? colors.green('✔') : '';
      return app;
    })
  };
};

// endpoint can be string or func(app)
const listEndpoint = async (endpoint, keyOverride) =>
  listEndpointMulti({ endpoint, keyOverride });

// takes {endpoint: string, keyOverride?: string}[]
const listEndpointMulti = async (...calls) => {
  await checkCredentials();
  const app = await getLinkedApp();
  let output = { app };

  for (const { endpoint, keyOverride } of calls) {
    if ((_.isFunction(endpoint) || endpoint.includes('/')) && !keyOverride) {
      throw new Error('must incude keyOverride with complex endpoint');
    }

    const route = _.isFunction(endpoint)
      ? endpoint(app)
      : `/apps/${app.id}/${endpoint}`;

    const results = await callAPI(route, {
      // if a full url comes out of the function, we have to use that
      url: route.startsWith('http') ? route : undefined
    });

    const { objects, ...theRest } = results;
    output = { ...output, [keyOverride || endpoint]: objects, ...theRest };
  }
  return output;
};

const listVersions = () => listEndpoint('versions');

const listHistory = () => listEndpoint('history');

const listInvitees = () => listEndpoint('invitees');

const listLogs = opts => {
  return listEndpoint(`logs?${qs.stringify(_.omit(opts, 'debug'))}`, 'logs');
};

const listEnv = version =>
  listEndpoint(`versions/${version}/environment`, 'env');

// the goal of this is to call `/check` with as much info as possible
// if the app is registered and auth is available, then we can send app id
// otherwise, we should just send the definition and get back checks about that
const validateApp = async definition => {
  // if either of these are missing, do the simple definition check
  if (
    _.isEmpty(await readCredentials(false)) ||
    _.isEmpty(await getLinkedAppConfig(undefined, false))
  ) {
    return callAPI('/check', {
      skipDeployKey: true,
      method: 'POST',
      body: { app_definition: definition }
    });
  }

  // otherwise, we have a "full" app. This could still fail (if their token is
  // present but bad, or they've lost access to that app), but should probably be fine.
  const linkedApp = await getLinkedApp(); // this fails in CI
  return callAPI('/check', {
    method: 'POST',
    body: {
      app_id: linkedApp.id,
      version: definition.version,
      app_definition: definition
    }
  });
};

const upload = async () => {
  const zipPath = constants.BUILD_PATH;
  const sourceZipPath = constants.SOURCE_PATH;
  const appDir = process.cwd();

  const fullZipPath = path.resolve(appDir, zipPath);
  const fullSourceZipPath = path.resolve(appDir, sourceZipPath);

  if (!fs.existsSync(fullZipPath)) {
    throw new Error(
      'Missing a built integration. Try running `zapier build` first.\nAlternatively, run `zapier push`, which will build and upload in one command.'
    );
  }

  const app = await getLinkedApp(appDir);
  const zip = new AdmZip(fullZipPath);
  const definitionJson = zip.readAsText('definition.json');
  if (!definitionJson) {
    throw new Error('definition.json in the zip was missing!');
  }
  const definition = JSON.parse(definitionJson);

  const binaryZip = fs.readFileSync(fullZipPath);
  const buffer = Buffer.from(binaryZip).toString('base64');

  const binarySourceZip = fs.readFileSync(fullSourceZipPath);
  const sourceBuffer = Buffer.from(binarySourceZip).toString('base64');

  startSpinner(`Uploading version ${definition.version}`);
  await callAPI(`/apps/${app.id}/versions/${definition.version}`, {
    method: 'PUT',
    body: {
      zip_file: buffer,
      source_zip_file: sourceBuffer
    }
  });

  endSpinner();
};

module.exports = {
  callAPI,
  checkCredentials,
  createCredentials,
  getLinkedApp,
  getLinkedAppConfig,
  getVersionInfo,
  listApps,
  listEndpoint,
  listEndpointMulti,
  listEnv,
  listHistory,
  listInvitees,
  listLogs,
  listVersions,
  readCredentials,
  upload,
  writeLinkedAppConfig,
  validateApp
};
