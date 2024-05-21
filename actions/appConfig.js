/* ***********************************************************************
 * ADOBE CONFIDENTIAL
 * ___________________
 *
 * Copyright 2024 Adobe
 * All Rights Reserved.
 *
 * NOTICE: All information contained herein is, and remains
 * the property of Adobe and its suppliers, if any. The intellectual
 * and technical concepts contained herein are proprietary to Adobe
 * and its suppliers and are protected by all applicable intellectual
 * property laws, including trade secret and copyright laws.
 * Dissemination of this information or reproduction of this material
 * is strictly forbidden unless prior written permission is obtained
 * from Adobe.
 ************************************************************************* */

const crypto = require('crypto');
const { strToArray, getAioLogger } = require('./utils');
const UrlInfo = require('./urlInfo');

// Max activation is 1hrs, set to 2hrs
const MAX_ACTIVATION_TIME = 2 * 60 * 60 * 1000;
const ENV_VAR_ACTIVATION_ID = '__OW_ACTIVATION_ID';

/**
 * This store the Graybox configs.
 */
class AppConfig {
    // set payload per activation
    configMap = { payload: {} };

    setAppConfig(params) {
        const payload = this.initPayload();
        getAioLogger().info(`Params in AppConfig: ${JSON.stringify(params)}`);
        // Called during action start to cleanup old entries
        this.removeOldPayload();

        // These are payload parameters
        payload.spToken = params.spToken;
        payload.adminPageUri = params.adminPageUri;
        payload.projectExcelPath = params.projectExcelPath;
        payload.rootFolder = params.rootFolder;
        payload.gbRootFolder = params.gbRootFolder;
        payload.promoteIgnorePaths = strToArray(params.promoteIgnorePaths) || [];
        payload.driveId = params.driveId;
        payload.draftsOnly = params.draftsOnly;
        payload.experienceName = params.experienceName;

        // These are from params set in the github configs
        this.configMap.spSite = params.spSite;
        this.configMap.spClientId = params.spClientId;
        this.configMap.spAuthority = params.spAuthority;
        this.configMap.clientId = params.clientId;
        this.configMap.tenantId = params.tenantId;
        this.configMap.certPassword = params.certPassword;
        this.configMap.certKey = params.certKey;
        this.configMap.certThumbprint = params.certThumbprint;
        this.configMap.enablePreview = this.getJsonFromStr(params.enablePreview, []);
        this.configMap.helixAdminApiKeys = this.getJsonFromStr(params.helixAdminApiKeys);
        this.configMap.bulkPreviewCheckInterval = parseInt(params.bulkPreviewCheckInterval || '30', 10);
        this.configMap.maxBulkPreviewChecks = parseInt(params.maxBulkPreviewChecks || '30', 10);
        this.configMap.groupCheckUrl = params.groupCheckUrl || 'https://graph.microsoft.com/v1.0/groups/{groupOid}/members?$count=true';
        this.configMap.grayboxUserGroups = this.getJsonFromStr(params.grayboxUserGroups, []);
        this.configMap.ignoreUserCheck = (params.ignoreUserCheck || '').trim().toLowerCase() === 'true';

        this.extractPrivateKey();

        payload.ext = {
            urlInfo: payload.adminPageUri ? new UrlInfo(payload.adminPageUri) : null
        };
    }

    // Activation Payload Related
    initPayload() {
        this.configMap.payload[this.getPayloadKey()] = {
            payloadAccessedOn: new Date().getTime()
        };
        return this.configMap.payload[this.getPayloadKey()];
    }

    getPayloadKey() {
        return process.env[ENV_VAR_ACTIVATION_ID];
    }

    getPayload() {
        this.configMap.payload[this.getPayloadKey()].payloadAccessedOn = new Date().getTime();
        return this.configMap.payload[this.getPayloadKey()];
    }

    removePayload() {
        delete this.configMap.payload[this.getPayloadKey()];
    }

    /**
     * Similar to LRU
     */
    removeOldPayload() {
        const { payload } = this.configMap;
        const payloadKeys = Object.keys(payload);
        const leastTime = new Date().getTime();
        payloadKeys
            .filter((key) => payload[key]?.payloadAccessedOn < leastTime - MAX_ACTIVATION_TIME)
            .forEach((key) => delete payload[key]);
    }

    // Configs related methods
    getConfig() {
        const { payload, ...configMap } = this.configMap;
        return { ...configMap, payload: this.getPayload() };
    }

    getJsonFromStr(str, def = {}) {
        try {
            return JSON.parse(str);
        } catch (err) {
            // Mostly bad string ignored
            getAioLogger().debug(`Error while parsing ${str}`);
        }
        return def;
    }

    getMsalConfig() {
        const {
            clientId, tenantId, certPassword, pvtKey, certThumbprint,
        } = this.configMap;
        return {
            clientId, tenantId, certPassword, pvtKey, certThumbprint,
        };
    }

    getSpSite() {
        return this.configMap.spSite;
    }

    getPromoteIgnorePaths() {
        const pips = this.getPayload().promoteIgnorePaths;
        return [...pips, '/.milo', '/.helix', '/metadata.xlsx', '*/query-index.xlsx'];
    }

    extractPrivateKey() {
        if (!this.configMap.certKey) return;
        const decodedKey = Buffer.from(
            this.configMap.certKey,
            'base64'
        ).toString('utf-8');
        this.configMap.pvtKey = crypto
            .createPrivateKey({
                key: decodedKey,
                passphrase: this.configMap.certPassword,
                format: 'pem',
            })
            .export({
                format: 'pem',
                type: 'pkcs8',
            });
    }

    getUrlInfo() {
        return this.getPayload().ext.urlInfo;
    }

    isDraftOnly() {
        const { draftsOnly } = this.getPayload();
        if (draftsOnly === undefined) {
            return true;
        }
        if (typeof draftsOnly === 'string') {
            return draftsOnly.trim().toLowerCase() !== 'false';
        }
        return draftsOnly;
    }

    ignoreUserCheck() {
        return true && this.configMap.ignoreUserCheck;
    }
}

module.exports = new AppConfig();
