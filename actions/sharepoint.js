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

import { Headers } from 'node-fetch';
import fetch from 'node-fetch';
import { getAioLogger } from './utils.js';
import SharepointAuth from './sharepointAuth.js';

const SP_CONN_ERR_LST = ['ETIMEDOUT', 'ECONNRESET'];
const APP_USER_AGENT = 'NONISV|Adobe|MiloFloodgate/0.1.0';
const NUM_REQ_THRESHOLD = 5;
const RETRY_ON_CF = 3;
const TOO_MANY_REQUESTS = '429';
// Added for debugging rate limit headers
const LOG_RESP_HEADER = false;
let nextCallAfter = 0;
const itemIdMap = {};
const logger = getAioLogger();

class Sharepoint {
    constructor(appConfig) {
        this.appConfig = appConfig;
        this.sharepointAuth = new SharepointAuth(this.appConfig.getMsalConfig());
    }

    getSharepointAuth() {
        return this.sharepointAuth;
    }

    async getAuthorizedRequestOption({ body = null, json = true, method = 'GET' } = {}) {
        const appSpToken = await this.sharepointAuth.getAccessToken();
        const bearer = `Bearer ${appSpToken}`;

        const headers = new Headers();
        headers.append('Authorization', bearer);
        headers.append('User-Agent', APP_USER_AGENT);
        if (json) {
            headers.append('Accept', 'application/json');
            headers.append('Content-Type', 'application/json');
        }

        const options = {
            method,
            headers,
        };

        if (body) {
            options.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        return options;
    }

    async executeGQL(url, opts) {
        const options = await this.getAuthorizedRequestOption(opts);
        const res = await this.fetchWithRetry(url, options);
        if (!res.ok) {
            throw new Error(`Failed to execute ${url}`);
        }
        return res.json();
    }

    async getItemId(uri, path) {
        const key = `~${uri}~${path}~`;
        itemIdMap[key] = itemIdMap[key] || await this.executeGQL(`${uri}${path}?$select=id`);
        return itemIdMap[key]?.id;
    }

    async getFileData(filePath, isGraybox) {
        const sp = await this.appConfig.getSpConfig();
        const options = await this.getAuthorizedRequestOption();
        const baseURI = isGraybox ? sp.api.directory.create.gbBaseURI : sp.api.directory.create.baseURI;
        const resp = await this.fetchWithRetry(`${baseURI}${filePath}`, options);
        const json = await resp.json();
        const fileDownloadUrl = json['@microsoft.graph.downloadUrl'];
        const fileSize = json.size;
        return { fileDownloadUrl, fileSize };
    }

    async getFileUsingDownloadUrl(downloadUrl) {
        const options = await this.getAuthorizedRequestOption({ json: false });
        const response = await this.fetchWithRetry(downloadUrl, options);
        if (response) {
            return response.blob();
        }
        return undefined;
    }

    async createFolder(folder, isGraybox) {
        const sp = await this.appConfig.getSpConfig();
        const options = await this.getAuthorizedRequestOption({ method: sp.api.directory.create.method });
        options.body = JSON.stringify(sp.api.directory.create.payload);

        const baseURI = isGraybox ? sp.api.directory.create.gbBaseURI : sp.api.directory.create.baseURI;
        const res = await this.fetchWithRetry(`${baseURI}${folder}`, options);
        if (res.ok) {
            return res.json();
        }
        throw new Error(`Could not create folder: ${folder}`);
    }

    getFolderFromPath(path) {
        if (path.includes('.')) {
            return path.substring(0, path.lastIndexOf('/'));
        }
        return path;
    }

    getFileNameFromPath(path) {
        return path.split('/').pop().split('/').pop();
    }

    async createUploadSession(sp, file, dest, filename, isGraybox) {
        let fileSize = file.size;
        if (Buffer.isBuffer(file)) {
            fileSize = Buffer.byteLength(file);
        }

        const payload = {
            ...sp.api.file.createUploadSession.payload,
            description: 'Preview file',
            fileSize,
            name: filename,
        };
        const options = await this.getAuthorizedRequestOption({ method: sp.api.file.createUploadSession.method });
        options.body = JSON.stringify(payload);

        const baseURI = isGraybox ? sp.api.file.createUploadSession.gbBaseURI : sp.api.file.createUploadSession.baseURI;

        const createdUploadSession = await this.fetchWithRetry(`${baseURI}${dest}:/createUploadSession`, options);
        return createdUploadSession.ok ? createdUploadSession.json() : undefined;
    }

    async uploadFile(sp, uploadUrl, file) {
        const options = await this.getAuthorizedRequestOption({
            json: false,
            method: sp.api.file.upload.method,
        });
        let fileSize = file.size;
        if (Buffer.isBuffer(file)) {
            fileSize = Buffer.byteLength(file);
        }
        // TODO API is limited to 60Mb, for more, we need to batch the upload.
        options.headers.append('Content-Length', fileSize);
        options.headers.append('Content-Range', `bytes 0-${fileSize - 1}/${fileSize}`);
        options.headers.append('Prefer', 'bypass-shared-lock');
        options.body = file;
        return this.fetchWithRetry(`${uploadUrl}`, options);
    }

    async deleteFile(sp, filePath) {
        const options = await this.getAuthorizedRequestOption({
            json: false,
            method: sp.api.file.delete.method,
        });
        options.headers.append('Prefer', 'bypass-shared-lock');
        return fetch(filePath, options);
    }

    async createSessionAndUploadFile(sp, file, dest, filename, isGraybox) {
        const createdUploadSession = await this.createUploadSession(sp, file, dest, filename, isGraybox);
        const status = {};
        if (createdUploadSession) {
            const uploadSessionUrl = createdUploadSession.uploadUrl;
            if (!uploadSessionUrl) {
                return status;
            }
            status.sessionUrl = uploadSessionUrl;
            const uploadedFile = await this.uploadFile(sp, uploadSessionUrl, file);
            if (!uploadedFile) {
                return status;
            }
            if (uploadedFile.ok) {
                status.uploadedFile = await uploadedFile.json();
                status.success = true;
            } else if (uploadedFile.status === 423) {
                status.locked = true;
            }
        }
        return status;
    }

    async saveFileSimple(file, dest, isGraybox) {
        try {
            const folder = this.getFolderFromPath(dest);
            const filename = this.getFileNameFromPath(dest);
            logger.info(`Saving file ${filename} to ${folder}`);
            await this.createFolder(folder, isGraybox);
            const sp = await this.appConfig.getSpConfig();

            const uploadFileStatus = await this.createSessionAndUploadFile(sp, file, dest, filename, isGraybox);
            if (uploadFileStatus.locked) {
                logger.info(`Locked file detected: ${dest}`);
                return { success: false, path: dest, errorMsg: 'File is locked' };
            }
            const uploadedFileJson = uploadFileStatus.uploadedFile;
            if (uploadedFileJson) {
                return { success: true, uploadedFileJson, path: dest };
            }
        } catch (error) {
            logger.info(`Error while saving file: ${dest} ::: ${error.message}`);
            return { success: false, path: dest, errorMsg: error.message };
        }
        return { success: false, path: dest };
    }

    async updateExcelTable(excelPath, tableName, values) {
        const sp = await this.appConfig.getSpConfig();
        // URI is set to the graybox sharepoint location where the promote project excel is created
        const itemId = await this.getItemId(sp.api.file.get.gbBaseURI, excelPath);
        if (itemId) {
            return this.executeGQL(`${sp.api.excel.update.baseItemsURI}/${itemId}/workbook/tables/${tableName}/rows`, {
                body: JSON.stringify({ values }),
                method: sp.api.excel.update.method,
            });
        }
        return {};
    }

    // fetch-with-retry added to check for Sharepoint RateLimit headers and 429 errors and to handle them accordingly.
    async fetchWithRetry(apiUrl, options, retryCounts) {
        let retryCount = retryCounts || 0;
        return new Promise((resolve, reject) => {
            const currentTime = Date.now();
            if (retryCount > NUM_REQ_THRESHOLD) {
                reject();
            } else if (nextCallAfter !== 0 && currentTime < nextCallAfter) {
                setTimeout(() => this.fetchWithRetry(apiUrl, options, retryCount)
                    .then((newResp) => resolve(newResp))
                    .catch((err) => reject(err)), nextCallAfter - currentTime);
            } else {
                retryCount += 1;
                fetch(apiUrl, options).then((resp) => {
                    this.logHeaders(resp);
                    const retryAfter = resp.headers.get('ratelimit-reset') || resp.headers.get('retry-after') || 0;
                    if ((resp.headers.get('test-retry-status') === TOO_MANY_REQUESTS) || (resp.status === TOO_MANY_REQUESTS)) {
                        nextCallAfter = Date.now() + retryAfter * 1000;
                        logger.info(`Retry ${nextCallAfter}`);
                        this.fetchWithRetry(apiUrl, options, retryCount)
                            .then((newResp) => resolve(newResp))
                            .catch((err) => reject(err));
                    } else {
                        nextCallAfter = retryAfter ? Math.max(Date.now() + retryAfter * 1000, nextCallAfter) : nextCallAfter;
                        resolve(resp);
                    }
                }).catch((err) => {
                    logger.warn(`Connection error ${apiUrl} with ${JSON.stringify(err)}`);
                    if (err && SP_CONN_ERR_LST.includes(err.code) && retryCount < NUM_REQ_THRESHOLD) {
                        logger.info(`Retry ${SP_CONN_ERR_LST}`);
                        nextCallAfter = Date.now() + RETRY_ON_CF * 1000;
                        return this.fetchWithRetry(apiUrl, options, retryCount)
                            .then((newResp) => resolve(newResp))
                            .catch((err2) => reject(err2));
                    }
                    return reject(err);
                });
            }
        });
    }

    getHeadersStr(response) {
        const headers = {};
        response?.headers?.forEach((value, name) => {
            headers[name] = value;
        });
        return JSON.stringify(headers);
    }

    getLogRespHeader = () => LOG_RESP_HEADER;

    logHeaders(response) {
        if (!this.getLogRespHeader()) return;
        const hdrStr = this.getHeadersStr(response);
        const logStr = `Status is ${response.status} with headers ${hdrStr}`;

        if (logStr.toUpperCase().indexOf('RATE') > 0 || logStr.toUpperCase().indexOf('RETRY') > 0) logger.info(logStr);
    }
}

export default Sharepoint;
