/* ************************************************************************
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
const appConfig = require('./appConfig');

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

function getSharepointConfig(applicationConfig) {
    // get drive id if available
    const { driveId } = applicationConfig.payload;
    const drive = driveId ? `/drives/${driveId}` : '/drive';

    const baseURI = `${applicationConfig.spSite}${drive}/root:${applicationConfig.payload.rootFolder}`;
    const gbBaseURI = `${applicationConfig.spSite}${drive}/root:${applicationConfig.payload.gbRootFolder}`;
    const baseItemsURI = `${applicationConfig.spSite}${drive}/items`;
    return {
        ...applicationConfig,
        clientApp: {
            auth: {
                clientId: applicationConfig.spClientId,
                authority: applicationConfig.spAuthority,
            },
            cache: { cacheLocation: 'sessionStorage' },
        },
        login: { redirectUri: '/tools/loc/spauth' },
        api: {
            url: GRAPH_API,
            file: {
                get: { baseURI, gbBaseURI },
                download: { baseURI: `${applicationConfig.spSite}${drive}/items` },
                upload: {
                    baseURI,
                    gbBaseURI,
                    method: 'PUT',
                },
                delete: {
                    baseURI,
                    gbBaseURI,
                    method: 'DELETE',
                },
                update: {
                    baseURI,
                    gbBaseURI,
                    method: 'PATCH',
                },
                createUploadSession: {
                    baseURI,
                    gbBaseURI,
                    method: 'POST',
                    payload: { '@microsoft.graph.conflictBehavior': 'replace' },
                },
                copy: {
                    baseURI,
                    gbBaseURI,
                    method: 'POST',
                    payload: { '@microsoft.graph.conflictBehavior': 'replace' },
                },
            },
            directory: {
                create: {
                    baseURI,
                    gbBaseURI,
                    method: 'PATCH',
                    payload: { folder: {} },
                },
            },
            excel: {
                get: { baseItemsURI },
                update: {
                    baseItemsURI,
                    method: 'POST',
                },
            },
            batch: { uri: `${GRAPH_API}/$batch` },
        },
    };
}

function getHelixAdminConfig() {
    const adminServerURL = 'https://admin.hlx.page';
    return {
        api: {
            status: { baseURI: `${adminServerURL}/status` },
            preview: { baseURI: `${adminServerURL}/preview` },
        },
    };
}

async function getConfig() {
    if (appConfig.getUrlInfo().isValid()) {
        const applicationConfig = appConfig.getConfig();

        return {
            sp: getSharepointConfig(applicationConfig),
            admin: getHelixAdminConfig(),
        };
    }
    return undefined;
}

module.exports = {
    getConfig,
};
